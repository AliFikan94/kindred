// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Kind, Status, State, TrancheInput, Tranche} from "./ScheduleTypes.sol";
import {ScheduleVault} from "./ScheduleVault.sol";

/// @title StakedScheduleVault
/// @notice A ScheduleVault whose native (MON) tranches wait in Monad's staking precompile and
///         come back, with rewards, in time for their unlock date.
///
/// @dev Everything that makes a tranche safe to deliver is inherited unchanged. This contract only
///      decides *when funds are liquid* and *how much a native tranche pays*:
///
///        Idle ──stake()──► Staked ──prepare()──► Unbonding ──(settle, inside execute/claim)──► Liquid
///
///      Rules that keep the product promise honest:
///      - A staked schedule is irrevocable: unbonding makes a safe cancel impossible in v1.
///      - A tranche pays  principal received + its share of harvested rewards - 10 % of those rewards.
///        Never more than the vault actually holds; never a promise about future yield.
///      - Only tranches unlocking at least MIN_STAKE_LEAD from now are staked; anything sooner stays
///        liquid, so no tranche is ever staked "too late to come back".
///      - ERC-20 and NFT tranches in the same schedule are not staked.
///
///      Monad staking facts used (verified against github.com/category-labs/monad, staking_contract.cpp):
///      delegation becomes active in epoch+1 (epoch+2 inside the boundary window) and can only be
///      undelegated once active; an undelegation can be withdrawn one epoch after its own activation
///      epoch (so up to ~3 epochs, ~17 h); withdrawal ids are uint8 and unique per delegator; rewards
///      are claimed separately and pulled to the delegator; a delegation must be >= 1 gwei.
contract StakedScheduleVault is ScheduleVault {
    // ------------------------------------------------------------------ precompile
    address internal constant STAKING = address(0x1000);
    bytes4 internal constant DELEGATE = 0x84994fec; // delegate(uint64)
    bytes4 internal constant UNDELEGATE = 0x5cf41514; // undelegate(uint64,uint256,uint8)
    bytes4 internal constant WITHDRAW = 0xaed2ee73; // withdraw(uint64,uint8)
    bytes4 internal constant CLAIM_REWARDS = 0xa76e2ca5; // claimRewards(uint64)
    bytes4 internal constant GET_DELEGATOR = 0x573c1ce0; // getDelegator(uint64,address)

    // ------------------------------------------------------------------ constants
    /// @notice Share of *rewards* (never principal) kept by the protocol, in basis points.
    uint256 public constant FEE_BPS = 1000;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant ACC_UNIT = 1e18;
    /// @dev Precompile calls are expensive (delegate ~260k, claimRewards ~155k at time of writing).
    uint256 internal constant STAKING_MIN_GAS = 900_000;
    /// @dev Tip slots per native tranche: prepare, settle, deliver.
    uint256 internal constant TIP_SLOTS = 3;

    /// @notice Keepers may start unbonding a tranche this long before it unlocks. Set at deploy.
    uint256 public immutable PREPARE_LEAD;
    /// @notice Tranches unlocking sooner than this after staking are left liquid.
    uint256 public immutable MIN_STAKE_LEAD;

    enum Stage {
        Idle, // liquid in the vault (not staked, or not stakeable)
        Staked, // delegated
        Unbonding, // undelegated, waiting for withdraw
        Liquid // withdrawn; `payout` is final
    }

    // ------------------------------------------------------------------ storage
    uint64 public validatorId;
    address public feeRecipient;
    uint256 public stakedNominal; // principal currently earning (Staked stage)
    uint256 public accYield; // harvested rewards per unit of staked principal, 1e18-scaled

    mapping(uint256 => Stage) public stage;
    mapping(uint256 => uint256) public accStart; // accYield when the tranche started earning
    mapping(uint256 => uint256) public yieldShare; // rewards attributed at prepare()
    mapping(uint256 => uint256) public payout; // final native payout once Liquid

    // ------------------------------------------------------------------ events
    event Staked(uint256 indexed id, uint256 amount);
    event Harvested(uint256 amount, uint256 accYield);
    event Unbonding(uint256 indexed id, uint256 principal, uint256 yieldShare);
    event Settled(uint256 indexed id, uint256 received, uint256 payout, uint256 fee);

    // ------------------------------------------------------------------ errors
    error UseInitializeStaked();
    error StakedMustBeIrrevocable();
    error BadValidator();
    error NotStakeable();
    error StakingCallFailed();

    constructor(uint256 prepareLead_) {
        PREPARE_LEAD = prepareLead_;
        // active (<= 2 epochs) + unbond (<= 3 epochs) must both fit, with margin.
        MIN_STAKE_LEAD = prepareLead_ + 1 days;
    }

    /// @dev The idle initializer is disabled on a staked vault.
    function initialize(address, address, bool, uint64, uint96, TrancheInput[] calldata) external payable override {
        revert UseInitializeStaked();
    }

    function initializeStaked(
        address creator_,
        address fallbackRecipient_,
        uint64 fundingDeadline_,
        uint96 tipPerExecution_,
        uint64 validatorId_,
        address feeRecipient_,
        TrancheInput[] calldata inputs
    ) external payable initializer {
        if (validatorId_ == 0) revert BadValidator();
        validatorId = validatorId_;
        feeRecipient = feeRecipient_;
        // irrevocable: see contract docs.
        _init(creator_, fallbackRecipient_, false, fundingDeadline_, tipPerExecution_, inputs);
    }

    function _tipSlots() internal pure override returns (uint256) {
        return TIP_SLOTS;
    }

    // ------------------------------------------------------------------ staking steps

    /// @notice Delegate every eligible native tranche. Permissionless; skips ones that cannot be
    ///         staked (too soon, already staked, wrong kind) and ones the precompile refuses.
    function stakeAll() external nonReentrant returns (uint256 staked) {
        if (state != State.Active) revert WrongState();
        uint256 n = _tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (_stake(i)) staked++;
        }
    }

    function stake(uint256 id) external nonReentrant {
        if (state != State.Active) revert WrongState();
        if (!_stake(id)) revert NotStakeable();
    }

    function _stake(uint256 id) private returns (bool) {
        if (id >= _tranches.length) return false;
        Tranche storage t = _tranches[id];
        if (t.kind != Kind.Native || t.status != Status.Pending || stage[id] != Stage.Idle) return false;
        if (uint256(t.unlockTime) < block.timestamp + MIN_STAKE_LEAD) return false;
        if (gasleft() < STAKING_MIN_GAS) revert InsufficientGas();

        uint256 amount = t.amountOrId;
        (bool ok, bytes memory ret) = STAKING.call{value: amount}(abi.encodeWithSelector(DELEGATE, validatorId));
        if (!ok || !_isTrue(ret)) return false;

        stage[id] = Stage.Staked;
        accStart[id] = accYield;
        stakedNominal += amount;
        emit Staked(id, amount);
        return true;
    }

    /// @notice Start unbonding a tranche inside its PREPARE_LEAD window so the principal is liquid
    ///         at unlock. Permissionless; pays the caller one tip.
    function prepare(uint256 id) external nonReentrant {
        if (!_canPrepare(id)) revert NotExecutable();
        if (gasleft() < STAKING_MIN_GAS) revert InsufficientGas();
        _prepare(id, msg.sender);
    }

    /// @notice Best-effort batch of prepare(); non-preparable tranches are skipped.
    function prepareMany(uint256[] calldata ids) external nonReentrant {
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_canPrepare(ids[i])) continue;
            if (gasleft() < STAKING_MIN_GAS) revert InsufficientGas();
            _prepare(ids[i], msg.sender);
        }
    }

    /// @notice Pull earned rewards into the vault and credit them to the staked tranches.
    ///         Never required for correctness (prepare() harvests too); useful for live balances.
    function harvest() external nonReentrant returns (uint256) {
        if (gasleft() < STAKING_MIN_GAS) revert InsufficientGas();
        return _harvest();
    }

    function _canPrepare(uint256 id) private view returns (bool) {
        if (state != State.Active || id >= _tranches.length) return false;
        Tranche storage t = _tranches[id];
        return t.status == Status.Pending && stage[id] == Stage.Staked && block.timestamp + PREPARE_LEAD >= t.unlockTime;
    }

    function _prepare(uint256 id, address keeper) private {
        Tranche storage t = _tranches[id];
        uint256 principal = t.amountOrId;

        // Rewards earned so far are shared among everyone still staked, including this tranche.
        _harvest();
        uint256 share = (principal * (accYield - accStart[id])) / ACC_UNIT;
        yieldShare[id] = share;
        stakedNominal -= principal;

        (bool ok, bytes memory ret) =
            STAKING.call(abi.encodeWithSelector(UNDELEGATE, validatorId, principal, uint8(id)));
        if (!ok || !_isTrue(ret)) revert StakingCallFailed();

        stage[id] = Stage.Unbonding;
        emit Unbonding(id, principal, share);
        _payTip(keeper); // each step runs once per tranche (stage machine), so one tip per step
    }

    /// @dev Withdraw a ready unbonding tranche and fix its final payout. Returns false if not ready yet.
    function _settle(uint256 id, address keeper) private returns (bool) {
        uint256 principal = _tranches[id].amountOrId;
        uint256 before = address(this).balance;
        (bool ok,) = STAKING.call(abi.encodeWithSelector(WITHDRAW, validatorId, uint8(id)));
        if (!ok) return false; // not ready (or refused): try again later

        uint256 received = address(this).balance - before;
        // Anything beyond the principal came from the unbonding slice's own rewards.
        uint256 extra = received > principal ? received - principal : 0;
        uint256 principalBack = received - extra;
        uint256 grossYield = yieldShare[id] + extra;
        uint256 fee = (grossYield * FEE_BPS) / BPS;

        payout[id] = principalBack + grossYield - fee;
        stage[id] = Stage.Liquid;
        emit Settled(id, received, payout[id], fee);

        if (fee > 0 && feeRecipient != address(0)) {
            bool sent;
            uint256 gasCap = TIP_GAS;
            address to = feeRecipient;
            assembly {
                sent := call(gasCap, to, fee, 0, 0, 0, 0)
            }
            // If the fee cannot be delivered it simply stays in the vault and returns to the creator.
            sent;
        }
        _payTip(keeper);
        return true;
    }

    function _harvest() private returns (uint256 h) {
        uint256 n = stakedNominal;
        if (n == 0) return 0;
        uint256 before = address(this).balance;
        (bool ok,) = STAKING.call(abi.encodeWithSelector(CLAIM_REWARDS, validatorId));
        if (!ok) return 0; // a failed harvest must never block a delivery
        h = address(this).balance - before;
        if (h > 0) {
            accYield += (h * ACC_UNIT) / n;
            emit Harvested(h, accYield);
        }
    }

    // ------------------------------------------------------------------ delivery hook

    function _readyToPay(uint256 id, address keeper) internal override returns (Readiness, uint256) {
        Tranche storage t = _tranches[id];
        Stage s = stage[id];
        if (t.kind != Kind.Native || s == Stage.Idle) return (Readiness.Ready, t.amountOrId);
        if (s == Stage.Liquid) return (Readiness.Ready, payout[id]);

        if (gasleft() < STAKING_MIN_GAS) revert InsufficientGas();
        if (s == Stage.Staked) {
            _prepare(id, keeper); // unlocked but never prepared: start unbonding now
            return (Readiness.Progressed, 0);
        }
        // Unbonding
        if (_settle(id, keeper)) return (Readiness.Ready, payout[id]);
        return (Readiness.Waiting, 0);
    }

    // ------------------------------------------------------------------ views

    /// @notice Principal + unclaimed rewards currently in the precompile for this vault (for UIs).
    ///         Returns (0, 0) if the precompile cannot be read.
    function stakedPosition() external view returns (uint256 stake_, uint256 unclaimedRewards) {
        (bool ok, bytes memory ret) =
            STAKING.staticcall(abi.encodeWithSelector(GET_DELEGATOR, validatorId, address(this)));
        if (!ok || ret.length < 96) return (0, 0);
        (stake_,, unclaimedRewards) = abi.decode(ret, (uint256, uint256, uint256));
    }

    function _isTrue(bytes memory ret) private pure returns (bool) {
        if (ret.length != 32) return false;
        uint256 w;
        assembly {
            w := mload(add(ret, 0x20))
        }
        return w == 1;
    }
}
