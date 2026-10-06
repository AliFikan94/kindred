// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test double for Monad's staking precompile at 0x1000. Behaviour mirrors
///      category/execution/monad/staking/staking_contract.cpp for the calls the vault makes:
///        - delegate: stake >= 1 gwei, active in epoch+1 (epoch+2 inside the boundary window)
///        - undelegate: only *active* stake, withdrawal ids are unique per delegator, dust is swept
///          into the withdrawal, effective in epoch+1 (+2 in the window)
///        - withdraw: ready once epoch >= requestEpoch + WITHDRAWAL_DELAY(1)
///        - claimRewards: pays accrued rewards to the caller
///      Plus knobs to simulate rewards (`accrue`), rewards embedded in a withdrawal, and losses.
///      Etched at 0x1000 with vm.etch, so it has no constructor state.
contract MockStaking {
    struct Del {
        uint256 stake;
        uint256 pending;
        uint64 pendingEpoch;
        uint256 rewards;
    }

    struct Req {
        uint256 amount;
        uint256 extra;
        uint64 epoch;
        bool exists;
    }

    uint64 public epoch;
    bool public inDelay;
    bool public failDelegate;
    bool public failClaim;
    mapping(uint64 => bool) public valExists;
    mapping(uint64 => mapping(address => Del)) internal _del;
    mapping(uint64 => mapping(address => mapping(uint8 => Req))) internal _req;

    uint256 internal constant DUST = 1 gwei;

    // ---- test controls
    function addValidator(uint64 id) external {
        valExists[id] = true;
    }

    function setEpoch(uint64 e) external {
        epoch = e;
    }

    function advance(uint64 n) external {
        epoch += n;
    }

    function setInDelay(bool b) external {
        inDelay = b;
    }

    function setFailDelegate(bool b) external {
        failDelegate = b;
    }

    function setFailClaim(bool b) external {
        failClaim = b;
    }

    function accrue(uint64 v, address who) external payable {
        _del[v][who].rewards += msg.value;
    }

    function accrueWithdrawal(uint64 v, address who, uint8 wid) external payable {
        _req[v][who][wid].extra += msg.value;
    }

    /// @dev Simulates a loss on an unbonding slice (bps of its amount).
    function haircut(uint64 v, address who, uint8 wid, uint256 bps) external {
        Req storage r = _req[v][who][wid];
        r.amount -= (r.amount * bps) / 10_000;
    }

    function activation() internal view returns (uint64) {
        return inDelay ? epoch + 2 : epoch + 1;
    }

    function _pull(Del storage d) internal {
        if (d.pendingEpoch != 0 && d.pendingEpoch <= epoch) {
            d.stake += d.pending;
            d.pending = 0;
            d.pendingEpoch = 0;
        }
    }

    // ---- precompile surface
    function delegate(uint64 v) external payable returns (bool) {
        require(valExists[v], "UnknownValidator");
        require(!failDelegate, "DelegateRefused");
        if (msg.value == 0) return true;
        require(msg.value >= DUST, "DelegationTooSmall");
        Del storage d = _del[v][msg.sender];
        _pull(d);
        d.pending += msg.value;
        d.pendingEpoch = activation();
        return true;
    }

    function undelegate(uint64 v, uint256 amount, uint8 wid) external returns (bool) {
        require(valExists[v], "UnknownValidator");
        if (amount == 0) return true;
        require(!_req[v][msg.sender][wid].exists, "WithdrawalIdExists");
        Del storage d = _del[v][msg.sender];
        _pull(d);
        require(d.stake >= amount, "InsufficientStake");
        d.stake -= amount;
        if (d.stake < DUST) {
            amount += d.stake;
            d.stake = 0;
        }
        _req[v][msg.sender][wid] = Req({amount: amount, extra: 0, epoch: activation(), exists: true});
        return true;
    }

    function withdraw(uint64 v, uint8 wid) external returns (bool) {
        Req memory r = _req[v][msg.sender][wid];
        require(r.exists, "UnknownWithdrawalId");
        require(epoch >= r.epoch + 1, "WithdrawalNotReady");
        delete _req[v][msg.sender][wid];
        (bool ok,) = msg.sender.call{value: r.amount + r.extra}("");
        require(ok, "send failed");
        return true;
    }

    function claimRewards(uint64 v) external returns (bool) {
        require(!failClaim, "ClaimRefused");
        Del storage d = _del[v][msg.sender];
        _pull(d);
        uint256 r = d.rewards;
        if (r != 0) {
            d.rewards = 0;
            (bool ok,) = msg.sender.call{value: r}("");
            require(ok, "send failed");
        }
        return true;
    }

    function getDelegator(uint64 v, address who)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256)
    {
        Del memory d = _del[v][who];
        uint256 stake = d.stake;
        uint256 pending = d.pending;
        if (d.pendingEpoch != 0 && d.pendingEpoch <= epoch) {
            stake += pending;
            pending = 0;
        }
        return (stake, 0, d.rewards, pending, 0, d.pendingEpoch, 0);
    }

    receive() external payable {}
}
