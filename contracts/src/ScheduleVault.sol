// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Kind, Status, State, TrancheInput, Tranche} from "./ScheduleTypes.sol";

/// @title ScheduleVault
/// @notice Holds assets for one Kindred schedule and releases each tranche on its unlock date.
///
/// @dev Design rule: *unlock is a fact of the contract; delivery is a service on top of it.*
///      From `unlockTime` the recipient can always `claim()` without any keeper. Keepers (anyone)
///      call `execute()` to push the funds for them and earn a small native tip.
///
///      No admin keys, no upgradeability. One instance per schedule (EIP-1167 clone).
///      See docs/SPEC.md for the invariants this contract is tested against.
contract ScheduleVault is Initializable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    uint256 public constant MAX_TRANCHES = 64;
    uint256 public constant CANCEL_DELAY = 7 days;
    uint256 public constant SWEEP_GRACE = 365 days;
    uint256 public constant MAX_HORIZON = 100 * 365 days;

    /// @dev Gas forwarded to a recipient/token during a push. A recipient that needs more
    ///      than this simply falls back to `claim()`.
    uint256 internal constant PUSH_GAS = 300_000;
    uint256 internal constant TIP_GAS = 50_000;
    /// @dev A push is only attempted if the caller supplied enough gas for the callee to
    ///      really receive PUSH_GAS (63/64 rule) plus our bookkeeping. This stops a caller
    ///      from forcing a false "failed" by starving the call.
    uint256 internal constant MIN_GAS_FOR_PUSH = (PUSH_GAS * 64) / 63 + 60_000;

    /// @dev Result of the delivery hook. `Waiting`: nothing can be done yet (callers revert or skip).
    ///      `Progressed`: a preparatory step ran (e.g. unbonding started) but nothing is payable yet.
    ///      `Ready`: pay `amount` now.
    enum Readiness {
        Waiting,
        Progressed,
        Ready
    }

    // ------------------------------------------------------------------ storage
    address public creator;
    address public fallbackRecipient;
    bool public revocable;
    State public state;
    uint64 public fundingDeadline;
    uint64 public cancelRequestedAt; // 0 = no cancel pending
    uint96 public tipPerExecution;
    uint256 public tipPool; // native reserved for keeper tips
    uint256 public openCount; // tranches not yet in a terminal status

    Tranche[] internal _tranches;

    struct Proposal {
        address to;
        uint64 at;
    }

    mapping(uint256 => Proposal) public proposals;

    // ------------------------------------------------------------------ events
    event Activated();
    event Abandoned();
    event Executed(uint256 indexed id, address indexed recipient, address indexed keeper);
    event DeliveryFailed(uint256 indexed id, address indexed recipient);
    event Claimed(uint256 indexed id, address indexed recipient);
    event Swept(uint256 indexed id, address indexed to);
    event CancelRequested(uint64 at);
    event CancelAborted();
    event CancelFinalized(uint256 cancelledCount);
    event RecipientChanged(uint256 indexed id, address indexed from, address indexed to);
    event RecipientProposed(uint256 indexed id, address indexed to, uint64 at);
    event ProposalRejected(uint256 indexed id);

    // ------------------------------------------------------------------ errors
    error BadTrancheCount();
    error BadTranche(uint256 index);
    error TipUnderfunded();
    error WrongState();
    error FundingExpired();
    error FundingNotExpired();
    error Underfunded();
    error NotCreator();
    error NotRecipient();
    error NotRevocable();
    error NotExecutable();
    error NotUnlocked();
    error AlreadyUnlocked();
    error CancelNotRequested();
    error CancelPending();
    error TimelockActive();
    error NothingToCancel();
    error GraceNotOver();
    error InsufficientGas();
    error PayoutFailed();
    error BadAddress();
    error NoProposal();

    constructor() {
        _disableInitializers();
    }

    // ------------------------------------------------------------------ setup

    /// @notice Called once by the factory in the same transaction that clones the vault.
    /// @dev `msg.value` must cover the tip reserve; anything above counts towards native funding.
    function initialize(
        address creator_,
        address fallbackRecipient_,
        bool revocable_,
        uint64 fundingDeadline_,
        uint96 tipPerExecution_,
        TrancheInput[] calldata inputs
    ) external payable virtual initializer {
        _init(creator_, fallbackRecipient_, revocable_, fundingDeadline_, tipPerExecution_, inputs);
    }

    function _init(
        address creator_,
        address fallbackRecipient_,
        bool revocable_,
        uint64 fundingDeadline_,
        uint96 tipPerExecution_,
        TrancheInput[] calldata inputs
    ) internal {
        uint256 n = inputs.length;
        if (n == 0 || n > MAX_TRANCHES) revert BadTrancheCount();
        if (creator_ == address(0) || fallbackRecipient_ == address(this)) revert BadAddress();

        creator = creator_;
        fallbackRecipient = fallbackRecipient_;
        revocable = revocable_;
        fundingDeadline = fundingDeadline_;
        tipPerExecution = tipPerExecution_;
        tipPool = uint256(tipPerExecution_) * n * _tipSlots();
        if (msg.value < tipPool) revert TipUnderfunded();

        uint256 horizon = block.timestamp + MAX_HORIZON;
        for (uint256 i = 0; i < n; i++) {
            TrancheInput calldata x = inputs[i];
            if (x.recipient == address(0) || x.recipient == address(this)) revert BadTranche(i);
            // Funding must be settled strictly before anything can unlock.
            if (x.unlockTime <= fundingDeadline_ || x.unlockTime > horizon) revert BadTranche(i);

            if (x.kind == Kind.Native) {
                if (x.token != address(0) || x.amountOrId == 0) revert BadTranche(i);
            } else {
                if (x.token.code.length == 0) revert BadTranche(i);
                if (x.kind == Kind.ERC20) {
                    if (x.amountOrId == 0) revert BadTranche(i);
                } else {
                    // The same NFT may not be promised twice.
                    for (uint256 j = 0; j < i; j++) {
                        TrancheInput calldata y = inputs[j];
                        if (y.kind == Kind.ERC721 && y.token == x.token && y.amountOrId == x.amountOrId) {
                            revert BadTranche(i);
                        }
                    }
                }
            }

            _tranches.push(
                Tranche({
                    recipient: x.recipient,
                    unlockTime: x.unlockTime,
                    kind: x.kind,
                    status: Status.Pending,
                    token: x.token,
                    amountOrId: x.amountOrId
                })
            );
        }
        openCount = n;
        // state stays AwaitingFunds (enum default).
    }

    receive() external payable {}

    /// @dev Accept NFTs so bridges/wallets can fund by safeTransferFrom.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ funding

    /// @notice Move AwaitingFunds -> Active once holdings cover every tranche and the tip reserve.
    /// @dev Permissionless: the creator, the factory, or an automated bridge flow may call it.
    function activate() external nonReentrant {
        if (state != State.AwaitingFunds) revert WrongState();
        if (block.timestamp > fundingDeadline) revert FundingExpired();
        _requireFunded();
        state = State.Active;
        emit Activated();
    }

    /// @notice Creator cancels an unfunded schedule immediately. Nothing was relied upon yet.
    function abandon() external {
        if (msg.sender != creator) revert NotCreator();
        _abandon();
    }

    /// @notice Anyone may close a schedule whose funding window lapsed.
    function refund() external {
        if (block.timestamp <= fundingDeadline) revert FundingNotExpired();
        _abandon();
    }

    function _abandon() private {
        if (state != State.AwaitingFunds) revert WrongState();
        for (uint256 i = 0; i < _tranches.length; i++) {
            _tranches[i].status = Status.Cancelled;
        }
        openCount = 0;
        _close();
        emit Abandoned();
    }

    function _requireFunded() private view {
        uint256 n = _tranches.length;
        uint256 nativeNeeded = tipPool;
        address[] memory toks = new address[](n);
        uint256[] memory need = new uint256[](n);
        uint256 k;

        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = _tranches[i];
            if (t.kind == Kind.Native) {
                nativeNeeded += t.amountOrId;
            } else if (t.kind == Kind.ERC20) {
                uint256 j;
                for (; j < k; j++) {
                    if (toks[j] == t.token) break;
                }
                if (j == k) {
                    toks[k] = t.token;
                    k++;
                }
                need[j] += t.amountOrId;
            } else if (IERC721(t.token).ownerOf(t.amountOrId) != address(this)) {
                revert Underfunded();
            }
        }
        if (address(this).balance < nativeNeeded) revert Underfunded();
        for (uint256 j = 0; j < k; j++) {
            if (IERC20(toks[j]).balanceOf(address(this)) < need[j]) revert Underfunded();
        }
    }

    // ------------------------------------------------------------------ delivery

    /// @notice Push one due tranche to its recipient. Permissionless; pays the caller a tip
    ///         the first time a tranche is attempted.
    function execute(uint256 id) external nonReentrant {
        if (!_execute(id, msg.sender)) revert NotExecutable();
    }

    /// @notice Best-effort batch. Tranches that are not executable are skipped, not reverted.
    function executeMany(uint256[] calldata ids) external nonReentrant {
        for (uint256 i = 0; i < ids.length; i++) {
            _execute(ids[i], msg.sender);
        }
    }

    function _execute(uint256 id, address keeper) private returns (bool) {
        if (state != State.Active || id >= _tranches.length) return false;
        Tranche storage t = _tranches[id];
        Status s = t.status;
        if ((s != Status.Pending && s != Status.Claimable) || block.timestamp < t.unlockTime) return false;
        if (gasleft() < MIN_GAS_FOR_PUSH) revert InsufficientGas();

        (Readiness r, uint256 amount) = _readyToPay(id, keeper);
        if (r == Readiness.Waiting) return false;
        if (r == Readiness.Progressed) return true;

        bool first = s == Status.Pending;
        address recipient = t.recipient;

        // Effects before interaction.
        t.status = Status.Delivered;
        if (proposals[id].to != address(0)) delete proposals[id];

        bool delivered = _push(t, recipient, amount);
        if (delivered) {
            emit Executed(id, recipient, keeper);
        } else {
            t.status = Status.Claimable;
            emit DeliveryFailed(id, recipient);
        }

        // Pay the keeper BEFORE a possible close: closing zeroes the tip reserve.
        if (first) _payTip(keeper);
        if (delivered) _terminal();
        return true;
    }

    /// @notice The recipient pulls their own tranche. Works with no keeper at all, from
    ///         `unlockTime` onwards. Reverts (rather than swallowing) if the transfer fails,
    ///         so the recipient sees the reason.
    function claim(uint256 id) external nonReentrant {
        if (state != State.Active) revert WrongState();
        Tranche storage t = _tranches[id];
        if (msg.sender != t.recipient) revert NotRecipient();
        Status s = t.status;
        if (s != Status.Pending && s != Status.Claimable) revert NotExecutable();
        if (block.timestamp < t.unlockTime) revert NotUnlocked();

        (Readiness r, uint256 amount) = _readyToPay(id, address(0));
        if (r == Readiness.Waiting) revert NotExecutable();
        if (r == Readiness.Progressed) return;

        t.status = Status.Delivered;
        if (proposals[id].to != address(0)) delete proposals[id];

        if (t.kind == Kind.Native) {
            (bool ok,) = payable(msg.sender).call{value: amount}("");
            if (!ok) revert PayoutFailed();
        } else if (t.kind == Kind.ERC20) {
            IERC20(t.token).safeTransfer(msg.sender, t.amountOrId);
        } else {
            // Plain transferFrom: the recipient chose this address themselves.
            IERC721(t.token).transferFrom(address(this), msg.sender, t.amountOrId);
        }
        emit Claimed(id, msg.sender);
        _terminal();
    }

    /// @notice Backstop for funds nobody collected for SWEEP_GRACE after unlock. Pays the
    ///         fallback recipient, or the creator if none (or if the fallback cannot receive).
    function sweep(uint256 id) external nonReentrant {
        if (state != State.Active) revert WrongState();
        Tranche storage t = _tranches[id];
        Status s = t.status;
        if (s != Status.Pending && s != Status.Claimable) revert NotExecutable();
        if (block.timestamp < uint256(t.unlockTime) + SWEEP_GRACE) revert GraceNotOver();
        if (gasleft() < MIN_GAS_FOR_PUSH * 2) revert InsufficientGas();

        (Readiness r, uint256 amount) = _readyToPay(id, msg.sender);
        if (r == Readiness.Waiting) revert NotExecutable();
        if (r == Readiness.Progressed) return;

        t.status = Status.Swept;
        address dest = fallbackRecipient == address(0) ? creator : fallbackRecipient;
        if (!_push(t, dest, amount)) {
            dest = creator;
            if (!_push(t, dest, amount)) revert PayoutFailed();
        }
        emit Swept(id, dest);
        _terminal();
    }

    // ------------------------------------------------------------------ recipient changes

    /// @notice The current recipient hands their claim to another address (e.g. their own
    ///         wallet after receiving a claim link, or after a key rotation).
    function setRecipient(uint256 id, address to) external {
        Tranche storage t = _tranches[id];
        if (msg.sender != t.recipient) revert NotRecipient();
        Status s = t.status;
        if (state != State.Active || (s != Status.Pending && s != Status.Claimable)) revert NotExecutable();
        if (to == address(0) || to == address(this)) revert BadAddress();
        emit RecipientChanged(id, msg.sender, to);
        t.recipient = to;
        if (proposals[id].to != address(0)) delete proposals[id];
    }

    /// @notice Revocable mode only: creator proposes a new recipient. Takes effect after
    ///         CANCEL_DELAY, only if the tranche has not unlocked, and the current recipient
    ///         may reject it.
    function proposeRecipient(uint256 id, address to) external {
        if (msg.sender != creator) revert NotCreator();
        if (!revocable) revert NotRevocable();
        Tranche storage t = _tranches[id];
        if (state != State.Active || t.status != Status.Pending) revert NotExecutable();
        if (block.timestamp >= t.unlockTime) revert AlreadyUnlocked();
        if (to == address(0) || to == address(this)) revert BadAddress();
        proposals[id] = Proposal({to: to, at: uint64(block.timestamp)});
        emit RecipientProposed(id, to, uint64(block.timestamp));
    }

    function finalizeRecipient(uint256 id) external {
        if (msg.sender != creator) revert NotCreator();
        Proposal memory p = proposals[id];
        if (p.to == address(0)) revert NoProposal();
        if (block.timestamp < uint256(p.at) + CANCEL_DELAY) revert TimelockActive();
        Tranche storage t = _tranches[id];
        if (t.status != Status.Pending) revert NotExecutable();
        if (block.timestamp >= t.unlockTime) revert AlreadyUnlocked();
        emit RecipientChanged(id, t.recipient, p.to);
        t.recipient = p.to;
        delete proposals[id];
    }

    function rejectProposal(uint256 id) external {
        if (msg.sender != _tranches[id].recipient) revert NotRecipient();
        if (proposals[id].to == address(0)) revert NoProposal();
        delete proposals[id];
        emit ProposalRejected(id);
    }

    // ------------------------------------------------------------------ cancel (revocable only)

    /// @notice Start the cancel timelock. Recipients can see this on-chain.
    function requestCancel() external {
        if (msg.sender != creator) revert NotCreator();
        if (!revocable) revert NotRevocable();
        if (state != State.Active) revert WrongState();
        if (cancelRequestedAt != 0) revert CancelPending();
        cancelRequestedAt = uint64(block.timestamp);
        emit CancelRequested(cancelRequestedAt);
    }

    function abortCancel() external {
        if (msg.sender != creator) revert NotCreator();
        if (cancelRequestedAt == 0) revert CancelNotRequested();
        cancelRequestedAt = 0;
        emit CancelAborted();
    }

    /// @notice After the timelock, return every tranche that has NOT yet unlocked to the
    ///         creator. Tranches that unlocked in the meantime are untouched.
    function finalizeCancel() external nonReentrant {
        if (msg.sender != creator) revert NotCreator();
        if (cancelRequestedAt == 0) revert CancelNotRequested();
        if (block.timestamp < uint256(cancelRequestedAt) + CANCEL_DELAY) revert TimelockActive();
        if (state != State.Active) revert WrongState();

        uint256 n = _tranches.length;
        uint256 count;
        uint256 nativeBack;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = _tranches[i];
            if (t.status != Status.Pending || block.timestamp >= t.unlockTime) continue;
            t.status = Status.Cancelled;
            if (proposals[i].to != address(0)) delete proposals[i];
            count++;
            if (t.kind == Kind.Native) {
                nativeBack += t.amountOrId;
            } else if (t.kind == Kind.ERC20) {
                IERC20(t.token).safeTransfer(creator, t.amountOrId);
            } else {
                IERC721(t.token).transferFrom(address(this), creator, t.amountOrId);
            }
        }
        if (count == 0) revert NothingToCancel();

        // Release the tips reserved for the cancelled tranches too.
        uint256 tipBack = uint256(tipPerExecution) * count;
        if (tipBack > tipPool) tipBack = tipPool;
        tipPool -= tipBack;
        nativeBack += tipBack;

        cancelRequestedAt = 0;
        openCount -= count;
        if (openCount == 0) _close();
        emit CancelFinalized(count);

        if (nativeBack > 0) {
            (bool ok,) = payable(creator).call{value: nativeBack}("");
            if (!ok) revert PayoutFailed();
        }
    }

    // ------------------------------------------------------------------ leftovers (Closed only)

    /// @notice Once Closed, nothing is owed to anyone: return all remaining native
    ///         (unused tips, over-funding) to the creator. Permissionless.
    function withdrawNative() external nonReentrant {
        if (state != State.Closed) revert WrongState();
        (bool ok,) = payable(creator).call{value: address(this).balance}("");
        if (!ok) revert PayoutFailed();
    }

    function rescueERC20(address token) external nonReentrant {
        if (state != State.Closed) revert WrongState();
        IERC20(token).safeTransfer(creator, IERC20(token).balanceOf(address(this)));
    }

    function rescueERC721(address token, uint256 tokenId) external nonReentrant {
        if (state != State.Closed) revert WrongState();
        IERC721(token).transferFrom(address(this), creator, tokenId);
    }

    // ------------------------------------------------------------------ views

    function trancheCount() external view returns (uint256) {
        return _tranches.length;
    }

    function tranche(uint256 id) external view returns (Tranche memory) {
        return _tranches[id];
    }

    function tranches() external view returns (Tranche[] memory) {
        return _tranches;
    }

    /// @notice True when the tranche has unlocked and is waiting to be delivered or claimed.
    function isDue(uint256 id) external view returns (bool) {
        Tranche storage t = _tranches[id];
        return (t.status == Status.Pending || t.status == Status.Claimable) && block.timestamp >= t.unlockTime
            && state == State.Active;
    }

    // ------------------------------------------------------------------ internals

    // ------------------------------------------------------------------ extension points

    /// @dev How many keeper tips are reserved per tranche (1 = deliver). Staked schedules reserve more.
    function _tipSlots() internal view virtual returns (uint256) {
        return 1;
    }

    /// @dev Called before paying tranche `id`, from execute / claim / sweep. The idle vault has
    ///      nothing to prepare: the funds are already here.
    function _readyToPay(uint256 id, address) internal virtual returns (Readiness, uint256) {
        return (Readiness.Ready, _tranches[id].amountOrId);
    }

    function _terminal() private {
        if (--openCount == 0) _close();
    }

    function _close() private {
        state = State.Closed;
        tipPool = 0;
        cancelRequestedAt = 0;
    }

    function _payTip(address keeper) internal {
        uint256 tip = tipPerExecution;
        if (keeper == address(0) || tip == 0 || tipPool < tip) return;
        tipPool -= tip;
        bool ok;
        uint256 gasCap = TIP_GAS;
        assembly {
            ok := call(gasCap, keeper, tip, 0, 0, 0, 0)
        }
        // If the keeper cannot receive, the tip stays in the vault and is returned to the creator.
        if (!ok) tipPool += tip;
    }

    /// @dev Never reverts because of the recipient/token: returns false instead. Return data is
    ///      not copied (no returndata bombs) and forwarded gas is capped.
    function _push(Tranche storage t, address to, uint256 nativeAmount) private returns (bool ok) {
        Kind kind = t.kind;
        uint256 amt = kind == Kind.Native ? nativeAmount : t.amountOrId;
        uint256 gasCap = PUSH_GAS;

        if (kind == Kind.Native) {
            assembly {
                ok := call(gasCap, to, amt, 0, 0, 0, 0)
            }
        } else if (kind == Kind.ERC20) {
            address token = t.token;
            bytes memory data = abi.encodeCall(IERC20.transfer, (to, amt));
            uint256 rsize;
            uint256 rval;
            assembly {
                ok := call(gasCap, token, 0, add(data, 0x20), mload(data), 0x00, 0x20)
                rsize := returndatasize()
                rval := mload(0x00)
            }
            if (ok) {
                // Accept: no return data (USDT-style) from a real contract, or a true bool.
                ok = rsize == 0 ? token.code.length > 0 : (rsize == 32 && rval == 1);
            }
        } else {
            try IERC721(t.token).safeTransferFrom{gas: gasCap}(address(this), to, amt) {
                ok = true;
            } catch {
                ok = false;
            }
        }
    }
}
