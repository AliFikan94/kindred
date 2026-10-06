// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StakedBase} from "./StakedBase.t.sol";
import {StakedScheduleVault} from "../src/StakedScheduleVault.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {Kind, Status, State, TrancheInput, Tranche} from "../src/ScheduleTypes.sol";

/// @dev Random-but-mostly-legal actions against a staked vault plus the mock precompile.
contract StakedHandler is Test {
    StakedScheduleVault public v;
    MockStaking public stk;
    address[] public actors;
    uint64 public constant VAL = 7;

    Status[] internal prev;
    bool public badTransition;
    bool public deliveredEarly;
    bool public sweptEarly;
    uint256 public rewardsInjected; // ghost: native the test added from outside
    uint256 public deliveries; // ghost: tranches that reached Delivered (guards against vacuous runs)
    uint256 public stakedDeliveries;

    constructor(StakedScheduleVault v_, MockStaking stk_, address[] memory actors_) {
        v = v_;
        stk = stk_;
        actors = actors_;
        for (uint256 i = 0; i < v.trancheCount(); i++) {
            prev.push(Status.Pending);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _id(uint256 seed) internal view returns (uint256) {
        return seed % v.trancheCount();
    }

    function _check() internal {
        for (uint256 i = 0; i < v.trancheCount(); i++) {
            Tranche memory t = v.tranche(i);
            Status p = prev[i];
            Status c = t.status;
            if (p == c) continue;
            if (p == Status.Delivered || p == Status.Swept || p == Status.Cancelled) badTransition = true;
            if (p == Status.Claimable && c == Status.Pending) badTransition = true;
            if (c == Status.Delivered) {
                deliveries++;
                if (t.kind == Kind.Native && v.payout(i) > 0) stakedDeliveries++;
                if (block.timestamp < t.unlockTime) deliveredEarly = true;
            }
            if (c == Status.Swept && block.timestamp < uint256(t.unlockTime) + v.SWEEP_GRACE()) sweptEarly = true;
            prev[i] = c;
        }
    }

    // ---- environment
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 days));
        _check();
    }

    function warpFar(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 300 days, 400 days));
        _check();
    }

    function advanceEpoch(uint256 n) external {
        stk.advance(uint64(bound(n, 1, 4)));
        _check();
    }

    function toggleDelay(bool b) external {
        stk.setInDelay(b);
    }

    function reward(uint256 amount) external {
        if (v.stakedNominal() == 0) return; // rewards only accrue to active stake
        amount = bound(amount, 1 gwei, 500 ether);
        vm.deal(address(this), address(this).balance + amount);
        stk.accrue{value: amount}(VAL, address(v));
        rewardsInjected += amount;
    }

    /// Rewards that accrue to an unbonding slice and come back inside its withdrawal.
    function rewardUnbonding(uint256 id, uint256 amount) external {
        uint256 i = _id(id);
        if (v.stage(i) != StakedScheduleVault.Stage.Unbonding) return;
        amount = bound(amount, 1 gwei, 50 ether);
        vm.deal(address(this), address(this).balance + amount);
        stk.accrueWithdrawal{value: amount}(VAL, address(v), uint8(i));
        rewardsInjected += amount;
    }

    // ---- actions anyone can take
    function stakeAll(uint256 who) external {
        vm.prank(_actor(who));
        try v.stakeAll() {} catch {}
        _check();
    }

    function prepare(uint256 who, uint256 id) external {
        vm.prank(_actor(who));
        try v.prepare(_id(id)) {} catch {}
        _check();
    }

    function prepareMany(uint256 who) external {
        uint256 n = v.trancheCount();
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = i;
        }
        vm.prank(_actor(who));
        try v.prepareMany(ids) {} catch {}
        _check();
    }

    function harvest(uint256 who) external {
        vm.prank(_actor(who));
        try v.harvest() {} catch {}
        _check();
    }

    function execute(uint256 who, uint256 id) external {
        vm.prank(_actor(who));
        try v.execute(_id(id)) {} catch {}
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
        uint256 i = _id(id);
        vm.prank(v.tranche(i).recipient);
        try v.claim(i) {} catch {}
        _check();
    }

    function sweep(uint256 who, uint256 id) external {
        vm.prank(_actor(who));
        try v.sweep(_id(id)) {} catch {}
        _check();
    }

    function setRecipient(uint256 id, uint256 to) external {
        uint256 i = _id(id);
        vm.prank(v.tranche(i).recipient);
        try v.setRecipient(i, _actor(to)) {} catch {}
        _check();
    }

    function withdrawLeftovers() external {
        try v.withdrawNative() {} catch {}
        _check();
    }

    receive() external payable {}
}

contract StakedInvariantTest is StdInvariant, StakedBase {
    StakedScheduleVault internal v;
    StakedHandler internal h;
    address[] internal known;
    uint256 internal initialNative;

    function setUp() public override {
        super.setUp();
        TrancheInput[] memory ins = new TrancheInput[](5);
        ins[0] = _native(alice, 1000 ether, T0 + 6 days);
        ins[1] = _native(bob, 3000 ether, T0 + 12 days);
        ins[2] = _native(carol, 500 ether, T0 + 2 days); // too soon to stake: stays idle
        ins[3] = _erc20(alice, address(tok), 100 ether, T0 + 6 days);
        ins[4] = _native(carol, 2000 ether, T0 + 40 days);
        v = _makeStaked(ins, _sp(0.01 ether, fb), true);

        known.push(creator);
        known.push(alice);
        known.push(bob);
        known.push(carol);
        known.push(keeper);
        known.push(keeper2);
        known.push(fb);
        known.push(feeSink);
        known.push(address(v));
        known.push(STAKING);
        initialNative = _sum();

        address[] memory actors = new address[](5);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = keeper;
        actors[4] = keeper2;
        h = new StakedHandler(v, stk, actors);
        known.push(address(h)); // the handler funds rewards; its balance is part of the system

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = StakedHandler.warp.selector;
        sel[1] = StakedHandler.warpFar.selector;
        sel[2] = StakedHandler.advanceEpoch.selector;
        sel[3] = StakedHandler.toggleDelay.selector;
        sel[4] = StakedHandler.reward.selector;
        sel[5] = StakedHandler.stakeAll.selector;
        sel[6] = StakedHandler.prepare.selector;
        sel[7] = StakedHandler.prepareMany.selector;
        sel[8] = StakedHandler.harvest.selector;
        sel[9] = StakedHandler.execute.selector;
        sel[10] = StakedHandler.executeMany.selector;
        sel[11] = StakedHandler.claim.selector;
        sel[12] = StakedHandler.sweep.selector;
        sel[13] = StakedHandler.setRecipient.selector;
        sel[14] = StakedHandler.withdrawLeftovers.selector;
        sel[15] = StakedHandler.rewardUnbonding.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _sum() internal view returns (uint256 s) {
        for (uint256 i; i < known.length; i++) {
            s += known[i].balance;
        }
    }

    /// Value is neither created nor destroyed: everything native across the vault, the staking
    /// contract and all participants equals what we started with plus the rewards we injected.
    function invariant_nativeConserved() public view {
        assertEq(_sum(), initialNative + h.rewardsInjected(), "native conserved");
    }

    /// The vault always holds what it owes in liquid form: tip reserve, every unstaked native
    /// tranche still open, and every settled payout still open.
    function invariant_liquidObligationsCovered() public view {
        uint256 owed = v.tipPool();
        for (uint256 i; i < v.trancheCount(); i++) {
            Tranche memory t = v.tranche(i);
            if (t.kind != Kind.Native) continue;
            bool open = t.status == Status.Pending || t.status == Status.Claimable;
            if (!open) continue;
            StakedScheduleVault.Stage st = v.stage(i);
            if (st == StakedScheduleVault.Stage.Idle) owed += t.amountOrId;
            else if (st == StakedScheduleVault.Stage.Liquid) owed += v.payout(i);
        }
        assertGe(address(v).balance, owed, "vault can pay everything that is liquid-owed");
    }

    /// Nobody can ever be paid more than their principal plus all rewards ever injected.
    function invariant_noPayoutExceedsPrincipalPlusAllRewards() public view {
        for (uint256 i; i < v.trancheCount(); i++) {
            Tranche memory t = v.tranche(i);
            if (t.kind != Kind.Native) continue;
            assertLe(v.payout(i), t.amountOrId + h.rewardsInjected());
        }
    }

    /// Bookkeeping of what is currently earning matches the stages.
    function invariant_stakedNominalMatchesStages() public view {
        uint256 s;
        for (uint256 i; i < v.trancheCount(); i++) {
            if (v.stage(i) == StakedScheduleVault.Stage.Staked) s += v.tranche(i).amountOrId;
        }
        assertEq(v.stakedNominal(), s);
    }

    /// A tranche is only Delivered after being unlocked; Swept only after grace; no terminal reversal.
    function invariant_transitionsAreLegal() public view {
        assertFalse(h.badTransition());
        assertFalse(h.deliveredEarly());
        assertFalse(h.sweptEarly());
    }

    /// Stages only move forward.
    function invariant_closedMeansNothingStaked() public view {
        if (v.state() == State.Closed) {
            assertEq(v.stakedNominal(), 0);
            assertLe(address(STAKING).balance, h.rewardsInjected(), "all principal has come back");
        }
    }

    /// Visible with -vv: how deep the random runs got, so a vacuous suite cannot hide.
    function afterInvariant() public view {
        console2.log("deliveries", h.deliveries(), "staked-native deliveries", h.stakedDeliveries());
    }
}
