// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StakedBase} from "./StakedBase.t.sol";
import {ScheduleFactory} from "../src/ScheduleFactory.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {StakedScheduleVault} from "../src/StakedScheduleVault.sol";
import {Kind, Status, State, TrancheInput, ScheduleParams} from "../src/ScheduleTypes.sol";

contract StakedVaultTest is StakedBase {
    // =====================================================================
    // creation
    // =====================================================================

    function test_create_staked_stakesAtOnce_andKeepsOnlyTipsLiquid() public {
        StakedScheduleVault v = _stakedOne(5000 ether, 10, 0.01 ether);
        assertEq(uint8(v.state()), uint8(State.Active));
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Staked));
        assertEq(v.stakedNominal(), 5000 ether);
        assertEq(address(STAKING).balance, 5000 ether);
        assertEq(address(v).balance, 0.03 ether, "3 tip slots per tranche stay liquid");
        assertEq(v.tipPool(), 0.03 ether);
        assertEq(v.validatorId(), VAL);
        assertFalse(v.revocable());
    }

    function test_create_validatorMustBeAllowlisted() public {
        ScheduleParams memory p = _sp(0, address(0));
        p.validatorId = 9;
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.ValidatorNotAllowed.selector);
        f.create{value: 1 ether}(p, _one(_native(alice, 1 ether, T0 + 10 days)), true);
    }

    function test_create_stakedCannotBeRevocable() public {
        ScheduleParams memory p = _sp(0, address(0));
        p.revocable = true;
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.StakedMustBeIrrevocable.selector);
        f.create{value: 1 ether}(p, _one(_native(alice, 1 ether, T0 + 10 days)), true);
    }

    function test_create_exactValueRequired() public {
        ScheduleParams memory p = _sp(0.01 ether, address(0));
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + 10 days));
        uint256 need = _stakedValue(ins, 0.01 ether);
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.WrongNativeAmount.selector);
        f.create{value: need + 1}(p, ins, true);
    }

    function test_staked_idleInitializerIsDisabled_andNoReinit() public {
        StakedScheduleVault v = _stakedOne(1 ether, 10, 0);
        TrancheInput[] memory ins = _one(_native(bob, 1, T0 + 10 days));
        vm.expectRevert(StakedScheduleVault.UseInitializeStaked.selector);
        v.initialize(bob, address(0), false, T0 + 100, 0, ins);
        vm.expectRevert();
        v.initializeStaked(bob, address(0), T0 + 100, 0, VAL, address(0), ins);
        // and the implementation itself cannot be initialized either
        StakedScheduleVault impl = StakedScheduleVault(payable(f.stakedImplementation()));
        vm.expectRevert();
        impl.initializeStaked(bob, address(0), T0 + 100, 0, VAL, address(0), ins);
    }

    function test_staked_isIrrevocable() public {
        StakedScheduleVault v = _stakedOne(1 ether, 10, 0);
        vm.startPrank(creator);
        vm.expectRevert(ScheduleVault.NotRevocable.selector);
        v.requestCancel();
        vm.expectRevert(ScheduleVault.NotRevocable.selector);
        v.proposeRecipient(0, bob);
        vm.stopPrank();
    }

    function test_predict_stakedAndIdleDiffer() public view {
        assertTrue(f.predict(creator, bytes32(uint256(1)), true) != f.predict(creator, bytes32(uint256(1)), false));
    }

    function test_tranchesTooSoon_areNotStaked_andDeliverIdle() public {
        // 2 days < MIN_STAKE_LEAD (3 days): stays liquid
        StakedScheduleVault v = _stakedOne(1000 ether, 2, 0);
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Idle));
        assertEq(address(STAKING).balance, 0);
        assertEq(address(v).balance, 1000 ether);
        vm.warp(T0 + 2 days);
        v.execute(0);
        assertEq(alice.balance, 1000 ether);
    }

    function test_stakingRefused_degradesToIdle_andStillDelivers() public {
        stk.setFailDelegate(true);
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Idle));
        assertEq(address(v).balance, 1000 ether);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 1000 ether, "exactly the principal, nothing lost");
    }

    function test_draftPath_fundLater_thenStakeAll() public {
        ScheduleParams memory p = _sp(0, address(0));
        StakedScheduleVault v = _makeStaked(_one(_native(alice, 1000 ether, T0 + 10 days)), p, false);
        vm.deal(creator, 2000 ether);
        vm.prank(creator);
        (bool ok,) = address(v).call{value: 1000 ether}(""); // e.g. an Aurora delivery
        assertTrue(ok);
        v.activate();
        assertEq(address(STAKING).balance, 0, "activate alone does not stake");
        vm.prank(keeper);
        assertEq(v.stakeAll(), 1);
        assertEq(address(STAKING).balance, 1000 ether);
        vm.expectRevert(StakedScheduleVault.NotStakeable.selector);
        v.stake(0);
        assertEq(v.stakeAll(), 0, "idempotent");
    }

    // =====================================================================
    // lifecycle: prepare -> settle -> deliver
    // =====================================================================

    function test_lifecycle_withRewardsFeeAndTips() public {
        StakedScheduleVault v = _stakedOne(5000 ether, 10, 0.01 ether);
        stk.advance(1); // stake becomes active
        _reward(address(v), 100 ether);

        vm.warp(T0 + 10 days - 48 hours); // window opens
        vm.prank(keeper);
        v.prepare(0);
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Unbonding));
        assertEq(v.yieldShare(0), 100 ether);
        assertEq(v.stakedNominal(), 0);
        assertEq(keeper.balance, 0.01 ether);
        assertEq(address(v).balance, 100 ether + 0.02 ether, "harvested rewards now sit in the vault");

        stk.advance(2); // unbonding done
        vm.warp(T0 + 10 days);
        vm.prank(keeper2);
        v.execute(0);

        assertEq(alice.balance, 5090 ether, "principal + 90% of rewards");
        assertEq(feeSink.balance, 10 ether, "10% of rewards only");
        assertEq(keeper2.balance, 0.02 ether, "settle + deliver tips");
        assertEq(address(v).balance, 0);
        assertEq(address(STAKING).balance, 0);
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_noRewards_paysExactPrincipal_noFee() public {
        StakedScheduleVault v = _stakedOne(777 ether, 10, 0);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 777 ether);
        assertEq(feeSink.balance, 0);
    }

    function test_recipientClaim_worksWithoutAnyKeeper_ever() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        _reward(address(v), 50 ether);
        vm.warp(T0 + 10 days);

        vm.prank(alice);
        v.claim(0); // nobody prepared: this call starts unbonding, pays nothing yet
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Unbonding));
        assertEq(alice.balance, 0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Pending));

        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotExecutable.selector); // still unbonding: nothing to do
        v.claim(0);

        stk.advance(2);
        vm.prank(alice);
        v.claim(0);
        assertEq(alice.balance, 1045 ether);
        assertEq(feeSink.balance, 5 ether);
    }

    function test_execute_whileUnbonding_revertsAndChangesNothing() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0.01 ether);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        vm.warp(T0 + 10 days); // unlocked, but the epoch has not advanced
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Unbonding));
        assertEq(uint8(_status(v, 0)), uint8(Status.Pending));
        // and a batch simply skips it
        uint256[] memory ids = new uint256[](1);
        v.executeMany(ids);
        assertEq(alice.balance, 0);
    }

    function test_prepare_windowAndRepeatRules() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours - 1);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.prepare(0); // too early
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.prepare(0); // already unbonding
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.prepare(5); // no such tranche
    }

    function test_prepare_beforeStakeIsActive_failsLoudly_thenSucceeds() public {
        stk.setInDelay(true); // worst case: activation takes 2 epochs
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        vm.warp(T0 + 10 days - 48 hours);
        vm.expectRevert(StakedScheduleVault.StakingCallFailed.selector);
        v.prepare(0); // stake not active yet: InsufficientStake from the precompile
        stk.advance(2);
        v.prepare(0);
        stk.advance(2); // inDelay => request is 2 epochs out, readiness needs 3
        vm.warp(T0 + 10 days);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        stk.advance(1);
        v.execute(0);
        assertEq(alice.balance, 1000 ether);
    }

    function test_prepareMany_skipsIneligible() public {
        TrancheInput[] memory ins =
            _two(_native(alice, 1000 ether, T0 + 10 days), _native(bob, 1000 ether, T0 + 30 days));
        StakedScheduleVault v = _makeStaked(ins, _sp(0, address(0)), true);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1; // outside window
        ids[1] = 0; // ok
        ids[2] = 9; // nonexistent
        v.prepareMany(ids);
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Unbonding));
        assertEq(uint8(v.stage(1)), uint8(StakedScheduleVault.Stage.Staked));
    }

    // =====================================================================
    // yield accounting
    // =====================================================================

    function test_yield_sharedProRataByPrincipal_acrossTranches() public {
        TrancheInput[] memory ins =
            _two(_native(alice, 1000 ether, T0 + 10 days), _native(bob, 3000 ether, T0 + 20 days));
        StakedScheduleVault v = _makeStaked(ins, _sp(0, address(0)), true);
        stk.advance(1);
        _reward(address(v), 80 ether);

        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0); // 80 shared over 4000 staked: alice's 1000 earns 20
        assertEq(v.yieldShare(0), 20 ether);
        assertEq(v.stakedNominal(), 3000 ether);

        _reward(address(v), 60 ether); // after alice left, only bob earns
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 1018 ether); // 1000 + 20 - 10%

        vm.warp(T0 + 20 days - 48 hours);
        v.prepare(1);
        assertEq(v.yieldShare(1), 120 ether); // 60 earlier share + 60 later
        stk.advance(2);
        vm.warp(T0 + 20 days);
        v.execute(1);
        assertEq(bob.balance, 3108 ether); // 3000 + 120 - 10%

        assertEq(feeSink.balance, 14 ether);
        assertEq(address(v).balance, 0);
        assertEq(address(STAKING).balance, 0);
        // everything that went in came out: 4000 principal + 140 rewards
        assertEq(alice.balance + bob.balance + feeSink.balance, 4140 ether);
    }

    /// A tranche that starts earning later must not share rewards harvested before it was staked.
    function test_yield_tranchStakedAfterAHarvest_doesNotShareEarlierRewards() public {
        stk.setFailDelegate(true); // both tranches start liquid
        TrancheInput[] memory ins =
            _two(_native(alice, 1000 ether, T0 + 20 days), _native(bob, 1000 ether, T0 + 30 days));
        StakedScheduleVault v = _makeStaked(ins, _sp(0, address(0)), true);
        stk.setFailDelegate(false);

        v.stake(0);
        stk.advance(1);
        _reward(address(v), 100 ether); // earned by alice's tranche alone
        assertEq(v.harvest(), 100 ether);
        v.stake(1); // bob's tranche joins afterwards
        assertEq(v.accStart(1), v.accYield());
        assertGt(v.accStart(1), 0);

        stk.advance(1);
        vm.warp(T0 + 18 days);
        v.prepare(0);
        assertEq(v.yieldShare(0), 100 ether);

        _reward(address(v), 50 ether); // only bob is staked now
        vm.warp(T0 + 28 days);
        v.prepare(1);
        assertEq(v.yieldShare(1), 50 ether, "bob must not get alice's earlier 100");

        stk.advance(3);
        vm.warp(T0 + 30 days);
        v.executeMany(_ids2());
        assertEq(alice.balance, 1090 ether);
        assertEq(bob.balance, 1045 ether);
        assertEq(address(v).balance, 0);
    }

    function _ids2() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[1] = 1;
    }

    /// If the precompile refuses to pay rewards, the principal still comes back and is delivered.
    function test_harvestRefused_neverBlocksDelivery_principalStillComesBack() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        _reward(address(v), 100 ether);
        stk.setFailClaim(true);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        assertEq(v.yieldShare(0), 0, "nothing harvested, nothing credited");
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 1000 ether, "exactly the principal");
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_yield_rewardsEmbeddedInTheUnbondingSlice_areCredited() public {
        StakedScheduleVault v = _stakedOne(5000 ether, 10, 0);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        vm.deal(address(this), 5 ether);
        stk.accrueWithdrawal{value: 5 ether}(VAL, address(v), 0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 5004.5 ether);
        assertEq(feeSink.balance, 0.5 ether);
    }

    function test_loss_onUnbonding_isNeverCoveredByOthers_andNothingReverts() public {
        StakedScheduleVault v = _stakedOne(5000 ether, 10, 0);
        stk.advance(1);
        _reward(address(v), 100 ether);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.haircut(VAL, address(v), 0, 1000); // 10% lost: only 4500 comes back
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 4590 ether, "what actually came back + 90% of rewards");
        assertEq(feeSink.balance, 10 ether);
        assertEq(address(v).balance, 0, "solvent to the wei");
    }

    function test_noFeeRecipient_feeStaysAndReturnsToCreator() public {
        uint64[] memory vals = new uint64[](1);
        vals[0] = VAL;
        f = new ScheduleFactory(60, 30 days, 1 ether, PREPARE_LEAD, address(0), vals);
        vm.prank(creator);
        tok.approve(address(f), type(uint256).max);

        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        _reward(address(v), 100 ether);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(alice.balance, 1090 ether);
        uint256 before = creator.balance;
        v.withdrawNative();
        assertEq(creator.balance - before, 10 ether, "undelivered fee goes back to the creator");
    }

    function test_harvest_isPermissionless_andHarmlessWithoutStake() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        _reward(address(v), 40 ether);
        vm.prank(keeper);
        assertEq(v.harvest(), 40 ether);
        assertEq(v.accYield(), 0.04e18);
        assertEq(v.harvest(), 0);
        // after the only tranche left, harvesting is a no-op
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        assertEq(v.harvest(), 0);
        assertEq(v.yieldShare(0), 40 ether);
    }

    function test_stakedPosition_view() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        (uint256 s0,) = v.stakedPosition();
        assertEq(s0, 0, "not yet active");
        stk.advance(1);
        _reward(address(v), 7 ether);
        (uint256 s1, uint256 r1) = v.stakedPosition();
        assertEq(s1, 1000 ether);
        assertEq(r1, 7 ether);
    }

    // =====================================================================
    // mixed schedules, sweep, tips, gas
    // =====================================================================

    function test_mixedSchedule_onlyNativeIsStaked() public {
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(alice, 1000 ether, T0 + 10 days);
        ins[1] = _erc20(bob, address(tok), 50 ether, T0 + 10 days);
        ins[2] = _nft(carol, address(nft), 3, T0 + 10 days);
        StakedScheduleVault v = _makeStaked(ins, _sp(0.01 ether, address(0)), true);
        assertEq(uint8(v.stage(1)), uint8(StakedScheduleVault.Stage.Idle));
        assertEq(uint8(v.stage(2)), uint8(StakedScheduleVault.Stage.Idle));
        assertEq(address(STAKING).balance, 1000 ether);

        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        uint256[] memory ids = new uint256[](3);
        ids[1] = 1;
        ids[2] = 2;
        vm.prank(keeper);
        v.executeMany(ids);
        assertEq(alice.balance, 1000 ether);
        assertEq(tok.balanceOf(bob), 50 ether);
        assertEq(nft.ownerOf(3), carol);
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_sweep_ofStakedTranche_needsTwoSteps_thenPaysFallback() public {
        StakedScheduleVault v = _makeStaked(_one(_native(alice, 1000 ether, T0 + 10 days)), _sp(0, fb), true);
        stk.advance(1);
        vm.warp(T0 + 10 days + 365 days);
        v.sweep(0); // starts unbonding
        assertEq(fb.balance, 0);
        stk.advance(2);
        v.sweep(0);
        assertEq(fb.balance, 1000 ether);
        assertEq(uint8(_status(v, 0)), uint8(Status.Swept));
    }

    function test_tips_eachStepPaidOnce_andRetriesNeverDrainOthers() public {
        TrancheInput[] memory ins =
            _two(_native(alice, 1000 ether, T0 + 10 days), _native(bob, 1000 ether, T0 + 20 days));
        StakedScheduleVault v = _makeStaked(ins, _sp(0.01 ether, address(0)), true);
        assertEq(v.tipPool(), 0.06 ether);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        vm.prank(keeper);
        v.prepare(0);
        assertEq(keeper.balance, 0.01 ether);
        vm.warp(T0 + 10 days);
        vm.startPrank(keeper2);
        // not ready: reverts, pays nothing
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        stk.advance(2);
        v.execute(0);
        vm.stopPrank();
        assertEq(keeper2.balance, 0.02 ether);
        assertEq(v.tipPool(), 0.03 ether, "bob's three tip slots are untouched");
    }

    function test_gasGuard_stakingCallsNeedHeadroom() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        vm.expectRevert(ScheduleVault.InsufficientGas.selector);
        v.prepare{gas: 400_000}(0);
        vm.expectRevert(ScheduleVault.InsufficientGas.selector);
        v.harvest{gas: 400_000}();
    }

    function test_recipientChange_stillWorks_beforeDelivery() public {
        StakedScheduleVault v = _stakedOne(1000 ether, 10, 0);
        vm.prank(alice);
        v.setRecipient(0, bob);
        stk.advance(1);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(bob.balance, 1000 ether);
    }

    function test_deliveryFailure_afterSettle_keepsPayoutFinalAndClaimable() public {
        // recipient that cannot receive: payout is fixed once settled; later claim pays the same amount
        address rej = address(new RejectsEther());
        StakedScheduleVault v = _makeStaked(_one(_native(rej, 1000 ether, T0 + 10 days)), _sp(0, address(0)), true);
        stk.advance(1);
        _reward(address(v), 100 ether);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(2);
        vm.warp(T0 + 10 days);
        v.execute(0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(uint8(v.stage(0)), uint8(StakedScheduleVault.Stage.Liquid));
        assertEq(v.payout(0), 1090 ether);
        vm.prank(rej);
        v.setRecipient(0, bob);
        vm.prank(bob);
        v.claim(0);
        assertEq(bob.balance, 1090 ether);
    }

    // =====================================================================
    // fuzz
    // =====================================================================

    /// Single tranche: the recipient gets exactly principal + 90% of rewards (to within rounding
    /// dust of the accumulator) and every wei is accounted for.
    function testFuzz_singleTranche_payoutAndConservation(uint96 amountSeed, uint96 rewardSeed, uint8 extraEpochs)
        public
    {
        uint256 amount = bound(amountSeed, 1 ether, 1_000_000 ether);
        uint256 reward = bound(rewardSeed, 0, 100_000 ether);
        vm.deal(creator, amount + 1 ether);
        StakedScheduleVault v = _stakedOne(amount, 10, 0);
        stk.advance(1);
        if (reward > 0) _reward(address(v), reward);
        vm.warp(T0 + 10 days - 48 hours);
        v.prepare(0);
        stk.advance(uint64(2 + (extraEpochs % 5)));
        vm.warp(T0 + 10 days);
        v.execute(0);

        uint256 fee = (reward * 1000) / 10_000;
        uint256 expected = amount + reward - fee;
        assertLe(alice.balance, expected);
        assertLe(expected - alice.balance, amount / 1e18 + 2, "only accumulator rounding dust may be missing");
        assertLe(feeSink.balance, fee);
        // nothing leaked: payout + fee + dust left in the vault == principal + rewards
        assertEq(alice.balance + feeSink.balance + address(v).balance, amount + reward);
    }
}

contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}
