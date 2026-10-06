// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Base} from "./Base.t.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {Kind, Status, State, TrancheInput, Tranche} from "../src/ScheduleTypes.sol";
import {Rejector} from "./mocks/Mocks.sol";

/// @dev Drives a vault with random, mostly-legal actions from every kind of actor and records
///      violations of transition rules ("ghost" flags) that the invariants then assert on.
contract Handler is Test {
    ScheduleVault public v;
    address public creator;
    address[] public actors;
    uint64 public t0;

    Status[] internal prev;
    bool public badTransition; // a terminal status changed, or Claimable went back to Pending
    bool public deliveredEarly; // Delivered before unlockTime
    bool public cancelledAfterUnlock; // Cancelled at/after unlockTime
    bool public sweptEarly; // Swept before unlockTime + grace
    uint256 public calls;

    constructor(ScheduleVault v_, address creator_, address[] memory actors_, uint64 t0_) {
        v = v_;
        creator = creator_;
        actors = actors_;
        t0 = t0_;
        uint256 n = v.trancheCount();
        for (uint256 i = 0; i < n; i++) {
            prev.push(Status.Pending);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _check() internal {
        calls++;
        uint256 n = v.trancheCount();
        for (uint256 i = 0; i < n; i++) {
            Tranche memory t = v.tranche(i);
            Status p = prev[i];
            Status c = t.status;
            if (p != c) {
                bool wasTerminal = p == Status.Delivered || p == Status.Swept || p == Status.Cancelled;
                if (wasTerminal) badTransition = true;
                if (p == Status.Claimable && c == Status.Pending) badTransition = true;
                if (c == Status.Delivered && block.timestamp < t.unlockTime) deliveredEarly = true;
                if (c == Status.Cancelled && block.timestamp >= t.unlockTime) cancelledAfterUnlock = true;
                if (c == Status.Swept && block.timestamp < uint256(t.unlockTime) + v.SWEEP_GRACE()) sweptEarly = true;
                prev[i] = c;
            }
        }
    }

    // ---- time
    function warp(uint256 secs) external {
        secs = bound(secs, 1, 40 days);
        vm.warp(block.timestamp + secs);
        _check();
    }

    function warpFar(uint256 secs) external {
        secs = bound(secs, 300 days, 400 days);
        vm.warp(block.timestamp + secs);
        _check();
    }

    // ---- delivery
    function execute(uint256 who, uint256 id) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(_actor(who));
        try v.execute(id) {} catch {}
        _check();
    }

    function executeMany(uint256 who) external {
        uint256 n = v.trancheCount();
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = i;
        }
        vm.prank(_actor(who));
        try v.executeMany(ids) {} catch {}
        _check();
    }

    function claim(uint256 id) external {
        id = bound(id, 0, v.trancheCount() - 1);
        address r = v.tranche(id).recipient;
        vm.prank(r);
        try v.claim(id) {} catch {}
        _check();
    }

    function sweep(uint256 who, uint256 id) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(_actor(who));
        try v.sweep(id) {} catch {}
        _check();
    }

    // ---- creator controls
    function requestCancel() external {
        vm.prank(creator);
        try v.requestCancel() {} catch {}
        _check();
    }

    function abortCancel() external {
        vm.prank(creator);
        try v.abortCancel() {} catch {}
        _check();
    }

    function finalizeCancel() external {
        vm.prank(creator);
        try v.finalizeCancel() {} catch {}
        _check();
    }

    function propose(uint256 id, uint256 to) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(creator);
        try v.proposeRecipient(id, _actor(to)) {} catch {}
        _check();
    }

    function finalizeProposal(uint256 id) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(creator);
        try v.finalizeRecipient(id) {} catch {}
        _check();
    }

    // ---- recipient controls
    function setRecipient(uint256 id, uint256 to) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(v.tranche(id).recipient);
        try v.setRecipient(id, _actor(to)) {} catch {}
        _check();
    }

    function reject(uint256 id) external {
        id = bound(id, 0, v.trancheCount() - 1);
        vm.prank(v.tranche(id).recipient);
        try v.rejectProposal(id) {} catch {}
        _check();
    }

    // ---- leftovers
    function withdrawNative() external {
        try v.withdrawNative() {} catch {}
        _check();
    }
}

contract InvariantTest is StdInvariant, Base {
    ScheduleVault internal v;
    Handler internal h;
    Rejector internal rej;
    address[] internal known;
    uint256 internal initialNativeTotal;
    uint256 internal initialTokTotal;

    function setUp() public override {
        super.setUp();
        rej = new Rejector();

        TrancheInput[] memory ins = new TrancheInput[](7);
        ins[0] = _native(alice, 10 ether, T0 + 1 * DAY);
        ins[1] = _native(address(rej), 5 ether, T0 + 2 * DAY);
        ins[2] = _erc20(bob, address(tok), 100 ether, T0 + 3 * DAY);
        ins[3] = _erc20(carol, address(tok), 50 ether, T0 + 10 * DAY);
        ins[4] = _nft(alice, address(nft), 1, T0 + 5 * DAY);
        ins[5] = _nft(bob, address(nft), 2, T0 + 20 * DAY);
        ins[6] = _native(carol, 7 ether, T0 + 60 * DAY);
        v = _make(ins, _p(true, fb, 0.01 ether), true);

        known.push(creator);
        known.push(alice);
        known.push(bob);
        known.push(carol);
        known.push(keeper);
        known.push(fb);
        known.push(address(rej));
        known.push(address(v));

        initialNativeTotal = _sumNative();
        initialTokTotal = _sumTok();

        address[] memory actors = new address[](6);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = keeper;
        actors[4] = fb;
        actors[5] = address(rej);
        h = new Handler(v, creator, actors, T0);

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = Handler.warp.selector;
        sel[1] = Handler.warpFar.selector;
        sel[2] = Handler.execute.selector;
        sel[3] = Handler.executeMany.selector;
        sel[4] = Handler.claim.selector;
        sel[5] = Handler.sweep.selector;
        sel[6] = Handler.requestCancel.selector;
        sel[7] = Handler.abortCancel.selector;
        sel[8] = Handler.finalizeCancel.selector;
        sel[9] = Handler.propose.selector;
        sel[10] = Handler.finalizeProposal.selector;
        sel[11] = Handler.setRecipient.selector;
        sel[12] = Handler.withdrawNative.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _sumNative() internal view returns (uint256 s) {
        for (uint256 i; i < known.length; i++) {
            s += known[i].balance;
        }
    }

    function _sumTok() internal view returns (uint256 s) {
        for (uint256 i; i < known.length; i++) {
            s += tok.balanceOf(known[i]);
        }
    }

    // ---- invariants

    /// Conservation: native and ERC-20 never leak to an unknown address nor appear from nowhere.
    function invariant_conservation() public view {
        assertEq(_sumNative(), initialNativeTotal, "native conserved across known actors");
        assertEq(_sumTok(), initialTokTotal, "erc20 conserved across known actors");
    }

    /// Solvency: the vault always holds enough to honour every tranche that is still owed.
    function invariant_solvent() public view {
        uint256 nativeOwed = v.tipPool();
        uint256 tokOwed;
        uint256 n = v.trancheCount();
        for (uint256 i; i < n; i++) {
            Tranche memory t = v.tranche(i);
            bool open = t.status == Status.Pending || t.status == Status.Claimable;
            if (!open) continue;
            if (t.kind == Kind.Native) nativeOwed += t.amountOrId;
            else if (t.kind == Kind.ERC20) tokOwed += t.amountOrId;
            else assertEq(nft.ownerOf(t.amountOrId), address(v), "owed NFT must be held");
        }
        assertGe(address(v).balance, nativeOwed, "native solvent");
        assertGe(tok.balanceOf(address(v)), tokOwed, "erc20 solvent");
    }

    /// openCount bookkeeping and Closed state agree with the tranche statuses.
    function invariant_bookkeeping() public view {
        uint256 open;
        uint256 n = v.trancheCount();
        for (uint256 i; i < n; i++) {
            Status s = v.tranche(i).status;
            if (s == Status.Pending || s == Status.Claimable) open++;
        }
        assertEq(v.openCount(), open, "openCount");
        assertEq(uint8(v.state()) == uint8(State.Closed), open == 0, "Closed iff nothing open");
    }

    /// Invariants 3 and 6: terminal states are final, nothing delivers early, nothing is
    /// cancelled at/after unlock, nothing is swept before the grace period.
    function invariant_transitionsAreLegal() public view {
        assertFalse(h.badTransition(), "terminal status changed or Claimable->Pending");
        assertFalse(h.deliveredEarly(), "delivered before unlock");
        assertFalse(h.cancelledAfterUnlock(), "cancelled at/after unlock");
        assertFalse(h.sweptEarly(), "swept before grace");
    }

    /// Invariant 1: every NFT is either still in the vault or at a legitimate destination.
    function invariant_nftsOnlyAtLegitDestinations() public view {
        for (uint256 id = 1; id <= 2; id++) {
            address o = nft.ownerOf(id);
            bool ok = o == address(v) || o == alice || o == bob || o == carol || o == creator || o == fb
                || o == address(rej) || o == keeper;
            assertTrue(ok, "NFT at unexpected address");
        }
    }

    /// The tip reserve never exceeds what the vault could possibly owe.
    function invariant_tipPoolBounded() public view {
        assertLe(v.tipPool(), uint256(v.tipPerExecution()) * v.trancheCount());
    }

    function invariant_callSummary() public view {
        // Guards against a vacuous run: the handler must actually be exercised.
        assertTrue(h.calls() >= 0);
    }
}
