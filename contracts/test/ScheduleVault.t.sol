// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {Kind, Status, State, TrancheInput, Tranche, ScheduleParams} from "../src/ScheduleTypes.sol";
import {
    TestERC20,
    NoReturnERC20,
    FeeERC20,
    BlocklistERC20,
    FalseReturnERC20,
    TestERC721,
    Rejector,
    GasBurner,
    Reentrant,
    BadKeeper
} from "./mocks/Mocks.sol";

contract ScheduleVaultTest is Base {
    // =====================================================================
    // creation & validation
    // =====================================================================

    function test_create_storesTranchesAndStartsAwaitingFundsWhenDraft() public {
        TrancheInput[] memory ins =
            _two(_native(alice, 1 ether, T0 + DAY), _erc20(bob, address(tok), 5 ether, T0 + 2 * DAY));
        ScheduleVault v = _make(ins, _p(true, fb, 0), false);

        assertEq(uint8(v.state()), uint8(State.AwaitingFunds));
        assertEq(v.trancheCount(), 2);
        assertEq(v.creator(), creator);
        assertEq(v.fallbackRecipient(), fb);
        assertTrue(v.revocable());
        assertEq(v.openCount(), 2);
        assertEq(v.tranche(1).recipient, bob);
        assertEq(v.tranche(1).amountOrId, 5 ether);
    }

    function test_create_fundNow_activates() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        assertEq(uint8(v.state()), uint8(State.Active));
        assertEq(address(v).balance, 1 ether);
    }

    function test_revert_zeroTranches() public {
        TrancheInput[] memory ins = new TrancheInput[](0);
        ScheduleParams memory p = _p(false, address(0), 0);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.BadTrancheCount.selector);
        f.create(p, ins, false);
    }

    function test_revert_tooManyTranches() public {
        TrancheInput[] memory ins = new TrancheInput[](65);
        for (uint256 i; i < 65; i++) {
            ins[i] = _native(alice, 1, T0 + DAY);
        }
        ScheduleParams memory p = _p(false, address(0), 0);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.BadTrancheCount.selector);
        f.create(p, ins, false);
    }

    function test_maxTranches_ok() public {
        TrancheInput[] memory ins = new TrancheInput[](64);
        for (uint256 i; i < 64; i++) {
            ins[i] = _native(alice, 1 ether, T0 + DAY + uint64(i));
        }
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        assertEq(v.trancheCount(), 64);
    }

    function test_revert_zeroRecipient() public {
        _expectBadTranche(_one(_native(address(0), 1, T0 + DAY)), 0);
    }

    function test_revert_unlockNotAfterFundingDeadline() public {
        // funding window is 1 hour
        _expectBadTranche(_one(_native(alice, 1, T0 + 1 hours)), 0);
        _expectBadTranche(_one(_native(alice, 1, T0)), 0);
    }

    function test_revert_unlockTooFar() public {
        _expectBadTranche(_one(_native(alice, 1, T0 + uint64(101 * 365 days))), 0);
    }

    function test_revert_zeroAmount() public {
        _expectBadTranche(_one(_native(alice, 0, T0 + DAY)), 0);
        _expectBadTranche(_one(_erc20(alice, address(tok), 0, T0 + DAY)), 0);
    }

    function test_revert_nativeWithToken() public {
        TrancheInput memory x = _native(alice, 1, T0 + DAY);
        x.token = address(tok);
        _expectBadTranche(_one(x), 0);
    }

    function test_revert_tokenNotAContract() public {
        _expectBadTranche(_one(_erc20(alice, address(0xBEEF), 1, T0 + DAY)), 0);
        _expectBadTranche(_one(_nft(alice, address(0xBEEF), 1, T0 + DAY)), 0);
    }

    function test_revert_duplicateNFT() public {
        _expectBadTranche(_two(_nft(alice, address(nft), 1, T0 + DAY), _nft(bob, address(nft), 1, T0 + 2 * DAY)), 1);
    }

    function test_sameNFTIdDifferentCollectionOk() public {
        TestERC721 other = new TestERC721();
        _make(
            _two(_nft(alice, address(nft), 1, T0 + DAY), _nft(bob, address(other), 1, T0 + DAY)),
            _p(false, address(0), 0),
            false
        );
    }

    function test_revert_tipUnderfunded() public {
        ScheduleParams memory p = _p(false, address(0), 0.1 ether);
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.TipUnderfunded.selector);
        f.create{value: 0.05 ether}(p, ins, false);
    }

    function _expectBadTranche(TrancheInput[] memory ins, uint256 idx) internal {
        ScheduleParams memory p = _p(false, address(0), 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ScheduleVault.BadTranche.selector, idx));
        f.create(p, ins, false);
    }

    function test_vault_cannotBeReinitialized() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        TrancheInput[] memory ins = _one(_native(bob, 1, T0 + 2 days));
        vm.expectRevert();
        v.initialize(bob, address(0), false, T0 + 100, 0, ins);
    }

    function test_implementation_cannotBeInitialized() public {
        ScheduleVault impl = ScheduleVault(payable(f.implementation()));
        TrancheInput[] memory ins = _one(_native(bob, 1, T0 + 2 days));
        vm.expectRevert();
        impl.initialize(bob, address(0), false, T0 + 100, 0, ins);
    }

    // =====================================================================
    // funding / activation
    // =====================================================================

    function test_activate_afterPlainTransfers_aurora_path() public {
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(alice, 1 ether, T0 + DAY);
        ins[1] = _erc20(bob, address(tok), 7 ether, T0 + DAY);
        ins[2] = _nft(carol, address(nft), 3, T0 + DAY);
        ScheduleVault v = _make(ins, _p(false, address(0), 0), false);

        // Funds arrive by ordinary transfers (what a bridge/intent would do).
        vm.deal(address(v), 1 ether);
        vm.expectRevert(ScheduleVault.Underfunded.selector);
        v.activate();
        vm.prank(creator);
        tok.transfer(address(v), 7 ether);
        vm.expectRevert(ScheduleVault.Underfunded.selector); // NFT still missing
        v.activate();
        vm.prank(creator);
        nft.safeTransferFrom(creator, address(v), 3); // vault implements onERC721Received

        vm.prank(keeper); // permissionless
        v.activate();
        assertEq(uint8(v.state()), uint8(State.Active));
    }

    function test_activate_countsTipReserve() public {
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0.1 ether), false);
        // vault holds the 0.1 tip reserve; native tranche still missing
        vm.expectRevert(ScheduleVault.Underfunded.selector);
        v.activate();
        vm.deal(address(v), 1.1 ether);
        v.activate();
    }

    function test_activate_sumsMultipleTranchesOfSameToken() public {
        TrancheInput[] memory ins =
            _two(_erc20(alice, address(tok), 3 ether, T0 + DAY), _erc20(bob, address(tok), 4 ether, T0 + 2 * DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0), false);
        vm.prank(creator);
        tok.transfer(address(v), 6 ether); // short by 1
        vm.expectRevert(ScheduleVault.Underfunded.selector);
        v.activate();
        vm.prank(creator);
        tok.transfer(address(v), 1 ether);
        v.activate();
    }

    function test_activate_revertsAfterDeadline() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, address(0), 0), false);
        vm.deal(address(v), 1 ether);
        vm.warp(T0 + 1 hours + 1);
        vm.expectRevert(ScheduleVault.FundingExpired.selector);
        v.activate();
    }

    function test_activate_twiceReverts() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.expectRevert(ScheduleVault.WrongState.selector);
        v.activate();
    }

    function test_feeOnTransferToken_cannotBeFunded() public {
        FeeERC20 fee = new FeeERC20();
        fee.mint(creator, 100 ether);
        vm.prank(creator);
        fee.approve(address(f), type(uint256).max);
        ScheduleParams memory p = _p(false, address(0), 0);
        TrancheInput[] memory ins = _one(_erc20(alice, address(fee), 10 ether, T0 + DAY));
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.Underfunded.selector);
        f.create(p, ins, true);
    }

    function test_noReturnToken_fundsAndDelivers() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        usdt.mint(creator, 100 ether);
        vm.prank(creator);
        usdt.approve(address(f), type(uint256).max);
        ScheduleParams memory p = _p(false, address(0), 0);
        TrancheInput[] memory ins = _one(_erc20(alice, address(usdt), 10 ether, T0 + DAY));
        vm.prank(creator);
        ScheduleVault v = ScheduleVault(payable(f.create(p, ins, true)));
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(usdt.balanceOf(alice), 10 ether);
        assertEq(uint8(_status(v, 0)), uint8(Status.Delivered));
    }

    function test_abandon_byCreator_returnsEverythingThroughWithdraws() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, address(0), 0.1 ether), false);
        vm.deal(address(v), 1.1 ether); // partially/over funded by mistake
        vm.prank(tok.balanceOf(address(this)) == 0 ? creator : creator);
        v.abandon();
        assertEq(uint8(v.state()), uint8(State.Closed));
        assertEq(uint8(_status(v, 0)), uint8(Status.Cancelled));
        uint256 before = creator.balance;
        v.withdrawNative(); // anyone, pays creator
        assertEq(creator.balance - before, 1.1 ether);
        assertEq(address(v).balance, 0);
    }

    function test_abandon_onlyCreator_andOnlyWhenAwaitingFunds() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, address(0), 0), false);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotCreator.selector);
        v.abandon();
        ScheduleVault funded = _simple(1 ether, 1, 0, true);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.WrongState.selector);
        funded.abandon();
    }

    function test_refund_afterDeadline_permissionless_andRescues() public {
        ScheduleVault v = _make(
            _two(_erc20(alice, address(tok), 5 ether, T0 + DAY), _nft(bob, address(nft), 2, T0 + DAY)),
            _p(false, address(0), 0),
            false
        );
        vm.startPrank(creator);
        tok.transfer(address(v), 2 ether); // partial funding
        nft.transferFrom(creator, address(v), 2);
        vm.stopPrank();

        vm.expectRevert(ScheduleVault.FundingNotExpired.selector);
        v.refund();
        vm.warp(T0 + 1 hours + 1);
        vm.prank(keeper);
        v.refund();
        assertEq(uint8(v.state()), uint8(State.Closed));

        uint256 balBefore = tok.balanceOf(creator);
        v.rescueERC20(address(tok));
        assertEq(tok.balanceOf(creator) - balBefore, 2 ether);
        v.rescueERC721(address(nft), 2);
        assertEq(nft.ownerOf(2), creator);
    }

    function test_leftoverWithdrawals_blockedUntilClosed() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.expectRevert(ScheduleVault.WrongState.selector);
        v.withdrawNative();
        vm.expectRevert(ScheduleVault.WrongState.selector);
        v.rescueERC20(address(tok));
        vm.expectRevert(ScheduleVault.WrongState.selector);
        v.rescueERC721(address(nft), 1);
    }

    // =====================================================================
    // delivery: execute
    // =====================================================================

    function test_execute_native_exactAmount_permissionless() public {
        ScheduleVault v = _simple(3.25 ether, 10, 0, false);
        vm.warp(T0 + 10 * DAY);
        vm.prank(keeper);
        v.execute(0);
        assertEq(alice.balance, 3.25 ether);
        assertEq(address(v).balance, 0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Delivered));
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_execute_beforeUnlock_reverts_atExactSecond_works() public {
        ScheduleVault v = _simple(1 ether, 10, 0, false);
        vm.warp(T0 + 10 * DAY - 1);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        vm.warp(T0 + 10 * DAY);
        v.execute(0);
        assertEq(alice.balance, 1 ether);
    }

    function test_execute_twiceReverts_noDoublePayout() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.warp(T0 + DAY);
        v.execute(0);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        assertEq(alice.balance, 1 ether);
    }

    function test_execute_badId_reverts() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.warp(T0 + DAY);
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(5);
    }

    function test_execute_erc20_and_nft_mixedSchedule() public {
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(alice, 1 ether, T0 + DAY);
        ins[1] = _erc20(alice, address(tok), 9 ether, T0 + DAY);
        ins[2] = _nft(alice, address(nft), 4, T0 + DAY);
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 2;
        v.executeMany(ids);
        assertEq(alice.balance, 1 ether);
        assertEq(tok.balanceOf(alice), 9 ether);
        assertEq(nft.ownerOf(4), alice);
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_executeMany_skipsNotDue_doesNotRevert() public {
        TrancheInput[] memory ins = _two(_native(alice, 1 ether, T0 + DAY), _native(bob, 1 ether, T0 + 5 * DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        vm.warp(T0 + 2 * DAY);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1; // not due
        ids[1] = 0; // due
        ids[2] = 99; // nonexistent
        v.executeMany(ids);
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 0);
        assertEq(uint8(_status(v, 1)), uint8(Status.Pending));
    }

    function test_tip_paidOnce_toKeeper_andLeftoverReturnedToCreator() public {
        TrancheInput[] memory ins = _two(_native(alice, 1 ether, T0 + DAY), _native(bob, 1 ether, T0 + 2 * DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0.01 ether), true);
        assertEq(v.tipPool(), 0.02 ether);

        vm.warp(T0 + DAY);
        vm.prank(keeper);
        v.execute(0);
        assertEq(keeper.balance, 0.01 ether);
        assertEq(v.tipPool(), 0.01 ether);

        // Bob claims himself: no keeper, so no tip is paid; reserve returns to creator at close.
        vm.warp(T0 + 2 * DAY);
        vm.prank(bob);
        v.claim(1);
        assertEq(uint8(v.state()), uint8(State.Closed));
        uint256 before = creator.balance;
        v.withdrawNative();
        assertEq(creator.balance - before, 0.01 ether);
    }

    function test_tip_keeperThatCannotReceive_doesNotBlockDelivery() public {
        ScheduleVault v = _simple(1 ether, 1, 0.01 ether, false);
        BadKeeper bk = new BadKeeper();
        vm.warp(T0 + DAY);
        bk.run(address(v), 0);
        assertEq(alice.balance, 1 ether); // delivered
        assertEq(v.tipPool(), 0); // closed -> reserve zeroed
        // the unpaid tip is recoverable
        uint256 before = creator.balance;
        v.withdrawNative();
        assertEq(creator.balance - before, 0.01 ether);
    }

    function test_execute_gasStarvedCaller_cannotForceFalseFailure() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.warp(T0 + DAY);
        vm.expectRevert(ScheduleVault.InsufficientGas.selector);
        v.execute{gas: 150_000}(0);
        // state untouched: still deliverable
        assertEq(uint8(_status(v, 0)), uint8(Status.Pending));
        v.execute(0);
        assertEq(alice.balance, 1 ether);
    }

    // =====================================================================
    // isolation: hostile recipients / tokens never block others
    // =====================================================================

    function test_rejectingRecipient_becomesClaimable_othersStillDeliver() public {
        Rejector rej = new Rejector();
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(address(rej), 1 ether, T0 + DAY);
        ins[1] = _native(bob, 2 ether, T0 + DAY);
        ins[2] = _native(carol, 3 ether, T0 + DAY);
        ScheduleVault v = _make(ins, _p(false, address(0), 0.01 ether), true);

        vm.warp(T0 + DAY);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 2;
        vm.prank(keeper);
        v.executeMany(ids);

        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(bob.balance, 2 ether);
        assertEq(carol.balance, 3 ether);
        assertEq(keeper.balance, 0.03 ether); // tip for every attempt
        assertEq(uint8(v.state()), uint8(State.Active));
        assertEq(v.openCount(), 1);
        assertEq(address(v).balance, 1 ether + 0.0 ether); // exactly the failed tranche (+ no tips left)
    }

    function test_rejectingRecipient_claimReverts_untilRecipientRotates() public {
        Rejector rej = new Rejector();
        ScheduleVault v = _make(_one(_native(address(rej), 1 ether, T0 + DAY)), _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));

        vm.expectRevert(ScheduleVault.PayoutFailed.selector);
        rej.doClaim(address(v), 0);

        vm.prank(address(rej));
        v.setRecipient(0, bob);
        vm.prank(bob);
        v.claim(0);
        assertEq(bob.balance, 1 ether);
    }

    function test_gasBurningRecipient_isBounded_andFallsBackToClaim() public {
        GasBurner gb = new GasBurner();
        TrancheInput[] memory ins = _two(_native(address(gb), 1 ether, T0 + DAY), _native(bob, 1 ether, T0 + DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        uint256[] memory ids = new uint256[](2);
        ids[1] = 1;
        uint256 g = gasleft();
        v.executeMany(ids);
        assertLt(g - gasleft(), 1_000_000, "burner must not consume more than the gas cap");
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(bob.balance, 1 ether);
    }

    function test_nftToContractWithoutReceiver_becomesClaimable_thenClaimableByRecipient() public {
        Rejector rej = new Rejector(); // its onERC721Received reverts
        ScheduleVault v = _make(_one(_nft(address(rej), address(nft), 5, T0 + DAY)), _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(nft.ownerOf(5), address(v));
        rej.doClaim(address(v), 0); // plain transferFrom, recipient's own choice
        assertEq(nft.ownerOf(5), address(rej));
    }

    function test_blocklistedERC20Recipient_thenUnblocked_retryByKeeper() public {
        BlocklistERC20 bl = new BlocklistERC20();
        bl.mint(creator, 100 ether);
        vm.prank(creator);
        bl.approve(address(f), type(uint256).max);
        bl.setBlocked(alice, true);

        TrancheInput[] memory ins = _one(_erc20(alice, address(bl), 10 ether, T0 + DAY));
        ScheduleParams memory p = _p(false, address(0), 0.01 ether);
        vm.prank(creator);
        ScheduleVault v = ScheduleVault(payable(f.create{value: 0.01 ether}(p, ins, true)));

        vm.warp(T0 + DAY);
        vm.prank(keeper);
        v.execute(0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(keeper.balance, 0.01 ether);

        bl.setBlocked(alice, false);
        vm.prank(carol);
        v.execute(0); // retry is allowed on Claimable
        assertEq(bl.balanceOf(alice), 10 ether);
        assertEq(carol.balance, 0, "no second tip for the same tranche");
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_falseReturningToken_isTreatedAsFailure() public {
        FalseReturnERC20 ft = new FalseReturnERC20();
        ft.mint(creator, 100 ether);
        vm.prank(creator);
        ft.approve(address(f), type(uint256).max);
        TrancheInput[] memory ins = _one(_erc20(alice, address(ft), 10 ether, T0 + DAY));
        ScheduleParams memory p = _p(false, address(0), 0);
        vm.prank(creator);
        ScheduleVault v = ScheduleVault(payable(f.create(p, ins, true)));
        ft.setFailing(true);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(uint8(_status(v, 0)), uint8(Status.Claimable));
        assertEq(ft.balanceOf(address(v)), 10 ether);
    }

    function test_reentrantRecipient_cannotDoubleSpend() public {
        Reentrant r = new Reentrant();
        TrancheInput[] memory ins = _two(_native(address(r), 1 ether, T0 + DAY), _native(bob, 1 ether, T0 + DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        r.arm(address(v), 0);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertTrue(r.reentered());
        assertFalse(r.reenterSucceeded());
        assertEq(address(r).balance, 1 ether);
        assertEq(address(v).balance, 1 ether); // bob's tranche untouched
    }

    function test_checksEffectsInteractions_recipientAlreadySeesDelivered() public {
        Reentrant r = new Reentrant();
        ScheduleVault v = _make(_one(_native(address(r), 1 ether, T0 + DAY)), _p(false, address(0), 0), true);
        r.arm(address(v), 0);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertTrue(r.observed());
        assertFalse(r.dueSeenDuringReceive(), "state must be final before the external call");
    }

    function test_retryOnClaimable_neverSpendsOtherTranchesTipReserve() public {
        BlocklistERC20 bl = new BlocklistERC20();
        bl.mint(creator, 100 ether);
        vm.prank(creator);
        bl.approve(address(f), type(uint256).max);
        bl.setBlocked(alice, true);

        TrancheInput[] memory ins =
            _two(_erc20(alice, address(bl), 10 ether, T0 + DAY), _native(bob, 1 ether, T0 + 2 * DAY));
        ScheduleParams memory p = _p(false, address(0), 0.01 ether);
        vm.prank(creator);
        ScheduleVault v = ScheduleVault(payable(f.create{value: 1.02 ether}(p, ins, true)));

        vm.warp(T0 + DAY);
        vm.startPrank(keeper);
        v.execute(0); // fails -> Claimable, tip #1 paid
        assertEq(v.tipPool(), 0.01 ether);
        assertEq(keeper.balance, 0.01 ether);
        v.execute(0); // retry, still blocked: must not pay another tip
        v.execute(0);
        assertEq(v.tipPool(), 0.01 ether, "retries must not drain the reserve of tranche 1");

        vm.warp(T0 + 2 * DAY);
        v.execute(1);
        vm.stopPrank();
        assertEq(keeper.balance, 0.02 ether, "tranche 1's tip was still there for its keeper");
    }

    function test_reentrantRecipient_viaClaim() public {
        Reentrant r = new Reentrant();
        ScheduleVault v = _make(
            _two(_native(address(r), 1 ether, T0 + DAY), _native(bob, 1 ether, T0 + DAY)),
            _p(false, address(0), 0),
            true
        );
        r.arm(address(v), 0);
        vm.warp(T0 + DAY);
        r.doClaim(address(v), 0);
        assertFalse(r.reenterSucceeded());
        assertEq(address(r).balance, 1 ether);
        assertEq(address(v).balance, 1 ether);
    }

    // =====================================================================
    // claim: liveness with no keeper
    // =====================================================================

    function test_claim_worksWithNoKeeper_fromUnlock() public {
        ScheduleVault v = _simple(1 ether, 30, 0.01 ether, true);
        vm.warp(T0 + 30 * DAY);
        vm.prank(alice);
        v.claim(0);
        assertEq(alice.balance, 1 ether);
        assertEq(uint8(_status(v, 0)), uint8(Status.Delivered));
    }

    function test_claim_notBeforeUnlock_notByStranger_notTwice() public {
        ScheduleVault v = _simple(1 ether, 30, 0, false);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotUnlocked.selector);
        v.claim(0);
        vm.warp(T0 + 30 * DAY);
        vm.prank(bob);
        vm.expectRevert(ScheduleVault.NotRecipient.selector);
        v.claim(0);
        vm.prank(alice);
        v.claim(0);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.WrongState.selector); // vault closed
        v.claim(0);
    }

    function test_claim_erc20_and_nft() public {
        TrancheInput[] memory ins =
            _two(_erc20(alice, address(tok), 8 ether, T0 + DAY), _nft(alice, address(nft), 6, T0 + DAY));
        ScheduleVault v = _make(ins, _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        vm.startPrank(alice);
        v.claim(0);
        v.claim(1);
        vm.stopPrank();
        assertEq(tok.balanceOf(alice), 8 ether);
        assertEq(nft.ownerOf(6), alice);
    }

    function test_creator_cannotTouchUnlockedFunds_evenIfIrrevocable() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.warp(T0 + DAY);
        vm.startPrank(creator);
        vm.expectRevert(ScheduleVault.NotRevocable.selector);
        v.requestCancel();
        vm.expectRevert(ScheduleVault.GraceNotOver.selector); // creator cannot grab unlocked funds early
        v.sweep(0);
        vm.stopPrank();
    }

    // =====================================================================
    // cancel (revocable): 7-day timelock, never touches unlocked tranches
    // =====================================================================

    function test_cancel_flow_returnsOnlyLockedTranches() public {
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(alice, 1 ether, T0 + 2 * DAY); // unlocks during timelock
        ins[1] = _erc20(bob, address(tok), 6 ether, T0 + 30 * DAY);
        ins[2] = _nft(carol, address(nft), 7, T0 + 30 * DAY);
        ScheduleVault v = _make(ins, _p(true, address(0), 0.01 ether), true);

        vm.warp(T0 + DAY);
        vm.prank(creator);
        v.requestCancel();
        assertEq(v.cancelRequestedAt(), T0 + DAY);

        vm.warp(T0 + 2 * DAY);
        v.execute(0); // unlocks and delivers during the timelock
        assertEq(alice.balance, 1 ether);

        vm.warp(T0 + DAY + 7 days - 1);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.TimelockActive.selector);
        v.finalizeCancel();

        vm.warp(T0 + DAY + 7 days);
        uint256 nativeBefore = creator.balance;
        uint256 tokBefore = tok.balanceOf(creator);
        vm.prank(creator);
        v.finalizeCancel();

        assertEq(tok.balanceOf(creator) - tokBefore, 6 ether);
        assertEq(nft.ownerOf(7), creator);
        assertEq(creator.balance - nativeBefore, 0.02 ether, "two cancelled tips refunded");
        assertEq(uint8(_status(v, 0)), uint8(Status.Delivered));
        assertEq(uint8(_status(v, 1)), uint8(Status.Cancelled));
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_cancel_doesNotTouchTrancheUnlockedButUndelivered() public {
        ScheduleVault v = _simple(1 ether, 3, 0, true);
        vm.warp(T0 + DAY);
        vm.prank(creator);
        v.requestCancel();
        vm.warp(T0 + DAY + 7 days); // tranche unlocked at day 3, nobody executed
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.NothingToCancel.selector);
        v.finalizeCancel();
        assertEq(uint8(_status(v, 0)), uint8(Status.Pending));
        vm.prank(alice);
        v.claim(0);
        assertEq(alice.balance, 1 ether);
    }

    function test_cancel_nativeTrancheRefundAndPartialClose() public {
        TrancheInput[] memory ins = _two(_native(alice, 1 ether, T0 + 2 * DAY), _native(bob, 4 ether, T0 + 60 * DAY));
        ScheduleVault v = _make(ins, _p(true, address(0), 0), true);
        vm.prank(creator);
        v.requestCancel();
        vm.warp(T0 + 7 days);
        uint256 before = creator.balance;
        vm.prank(creator);
        v.finalizeCancel();
        assertEq(creator.balance - before, 4 ether);
        assertEq(uint8(v.state()), uint8(State.Active)); // alice's tranche still open
        assertEq(address(v).balance, 1 ether);
        // alice's tranche is untouched and still deliverable
        v.execute(0);
        assertEq(alice.balance, 1 ether);
    }

    function test_cancel_abort_andPermissions() public {
        ScheduleVault v = _simple(1 ether, 30, 0, true);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotCreator.selector);
        v.requestCancel();
        vm.startPrank(creator);
        vm.expectRevert(ScheduleVault.CancelNotRequested.selector);
        v.abortCancel();
        vm.expectRevert(ScheduleVault.CancelNotRequested.selector);
        v.finalizeCancel();
        v.requestCancel();
        vm.expectRevert(ScheduleVault.CancelPending.selector);
        v.requestCancel();
        v.abortCancel();
        assertEq(v.cancelRequestedAt(), 0);
        vm.stopPrank();
        vm.warp(T0 + 8 days);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.CancelNotRequested.selector);
        v.finalizeCancel();
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotCreator.selector);
        v.finalizeCancel();
    }

    // =====================================================================
    // recipient changes
    // =====================================================================

    function test_setRecipient_byRecipient_only() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.prank(bob);
        vm.expectRevert(ScheduleVault.NotRecipient.selector);
        v.setRecipient(0, bob);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.NotRecipient.selector);
        v.setRecipient(0, creator);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.BadAddress.selector);
        v.setRecipient(0, address(0));
        vm.prank(alice);
        v.setRecipient(0, bob);
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(bob.balance, 1 ether);
        assertEq(alice.balance, 0);
    }

    function test_setRecipient_notAfterDelivery() public {
        ScheduleVault v = _simple(1 ether, 1, 0, false);
        vm.warp(T0 + DAY);
        v.execute(0);
        vm.prank(alice);
        vm.expectRevert();
        v.setRecipient(0, bob);
    }

    function test_proposal_flow_timelocked_and_rejectable() public {
        ScheduleVault v = _simple(1 ether, 30, 0, true);
        vm.prank(creator);
        v.proposeRecipient(0, bob);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.TimelockActive.selector);
        v.finalizeRecipient(0);
        vm.warp(T0 + 7 days);
        vm.prank(creator);
        v.finalizeRecipient(0);
        assertEq(v.tranche(0).recipient, bob);

        // second proposal gets rejected by the (new) recipient
        vm.prank(creator);
        v.proposeRecipient(0, carol);
        vm.prank(bob);
        v.rejectProposal(0);
        vm.warp(T0 + 20 days);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.NoProposal.selector);
        v.finalizeRecipient(0);
    }

    function test_proposal_cannotFinalizeAfterUnlock() public {
        ScheduleVault v = _simple(1 ether, 10, 0, true);
        vm.prank(creator);
        v.proposeRecipient(0, bob);
        vm.warp(T0 + 10 * DAY);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.AlreadyUnlocked.selector);
        v.finalizeRecipient(0);
        // and cannot even propose after unlock
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.AlreadyUnlocked.selector);
        v.proposeRecipient(0, bob);
    }

    function test_proposal_irrevocableForbidden_recipientChangeClearsProposal() public {
        ScheduleVault irr = _simple(1 ether, 10, 0, false);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.NotRevocable.selector);
        irr.proposeRecipient(0, bob);

        ScheduleVault v = _simple(1 ether, 30, 0, true);
        vm.prank(creator);
        v.proposeRecipient(0, bob);
        vm.prank(alice);
        v.setRecipient(0, carol); // recipient acting clears the creator's proposal
        vm.warp(T0 + 8 days);
        vm.prank(creator);
        vm.expectRevert(ScheduleVault.NoProposal.selector);
        v.finalizeRecipient(0);
        assertEq(v.tranche(0).recipient, carol);
    }

    // =====================================================================
    // sweep (backstop)
    // =====================================================================

    function test_sweep_pendingAfterGrace_toFallback() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, fb, 0), true);
        vm.warp(T0 + DAY + 365 days - 1);
        vm.expectRevert(ScheduleVault.GraceNotOver.selector);
        v.sweep(0);
        vm.warp(T0 + DAY + 365 days);
        vm.prank(keeper);
        v.sweep(0);
        assertEq(fb.balance, 1 ether);
        assertEq(uint8(_status(v, 0)), uint8(Status.Swept));
        assertEq(uint8(v.state()), uint8(State.Closed));
    }

    function test_sweep_noFallback_goesToCreator() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, address(0), 0), true);
        vm.warp(T0 + DAY + 365 days);
        uint256 before = creator.balance;
        v.sweep(0);
        assertEq(creator.balance - before, 1 ether);
    }

    function test_sweep_fallbackThatRejects_fallsBackToCreator() public {
        Rejector rej = new Rejector();
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, address(rej), 0), true);
        vm.warp(T0 + DAY + 365 days);
        uint256 before = creator.balance;
        v.sweep(0);
        assertEq(creator.balance - before, 1 ether);
    }

    function test_sweep_claimableTranche() public {
        Rejector rej = new Rejector();
        ScheduleVault v = _make(_one(_native(address(rej), 1 ether, T0 + DAY)), _p(false, fb, 0), true);
        vm.warp(T0 + DAY);
        v.execute(0);
        vm.warp(T0 + DAY + 365 days);
        v.sweep(0);
        assertEq(fb.balance, 1 ether);
    }

    function test_sweep_erc20AndNft() public {
        TrancheInput[] memory ins =
            _two(_erc20(alice, address(tok), 3 ether, T0 + DAY), _nft(alice, address(nft), 8, T0 + DAY));
        ScheduleVault v = _make(ins, _p(false, fb, 0), true);
        vm.warp(T0 + DAY + 365 days);
        v.sweep(0);
        v.sweep(1);
        assertEq(tok.balanceOf(fb), 3 ether);
        assertEq(nft.ownerOf(8), fb);
    }

    function test_sweep_recipientCanStillClaimBeforeGraceEnds() public {
        ScheduleVault v = _make(_one(_native(alice, 1 ether, T0 + DAY)), _p(false, fb, 0), true);
        vm.warp(T0 + DAY + 364 days);
        vm.prank(alice);
        v.claim(0);
        assertEq(alice.balance, 1 ether);
    }

    // =====================================================================
    // views
    // =====================================================================

    function test_isDue_and_tranchesView() public {
        ScheduleVault v = _simple(1 ether, 2, 0, false);
        assertFalse(v.isDue(0));
        vm.warp(T0 + 2 * DAY);
        assertTrue(v.isDue(0));
        Tranche[] memory all = v.tranches();
        assertEq(all.length, 1);
        assertEq(all[0].recipient, alice);
        v.execute(0);
        assertFalse(v.isDue(0));
    }

    function test_vaultAcceptsPlainNativeTransfers() public {
        ScheduleVault v = _simple(1 ether, 2, 0, false);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // =====================================================================
    // fuzz
    // =====================================================================

    /// Invariant 2 (exactness, idle): whatever the amount and whenever it is executed after
    /// unlock, the recipient receives exactly the promised amount.
    function testFuzz_exactDelivery_native(uint96 amount, uint32 delayAfterUnlock, uint96 tip) public {
        amount = uint96(bound(amount, 1, 1_000 ether));
        tip = uint96(bound(tip, 0, 0.5 ether));
        ScheduleVault v = _make(_one(_native(alice, amount, T0 + DAY)), _p(false, address(0), tip), true);
        vm.warp(T0 + DAY + bound(delayAfterUnlock, 0, 300 days));
        vm.prank(keeper);
        v.execute(0);
        assertEq(alice.balance, amount);
    }

    function testFuzz_exactDelivery_erc20_viaClaim(uint128 amount) public {
        amount = uint128(bound(amount, 1, 1_000_000 ether));
        ScheduleVault v = _make(_one(_erc20(alice, address(tok), amount, T0 + DAY)), _p(false, address(0), 0), true);
        vm.warp(T0 + DAY);
        vm.prank(alice);
        v.claim(0);
        assertEq(tok.balanceOf(alice), amount);
    }

    /// Nobody but the recipient / a keeper (to the recipient) / the creator-for-cancel
    /// can ever move funds: random strangers calling every external function change nothing.
    function testFuzz_strangerCannotMoveFunds(address stranger, uint256 id) public {
        vm.assume(stranger != alice && stranger != creator && stranger != address(0));
        vm.assume(stranger.code.length == 0);
        ScheduleVault v = _simple(1 ether, 30, 0, true);
        uint256 strangerBefore = stranger.balance;
        vm.startPrank(stranger);
        vm.expectRevert();
        v.claim(id);
        vm.expectRevert();
        v.setRecipient(id, stranger);
        vm.expectRevert();
        v.requestCancel();
        vm.expectRevert();
        v.proposeRecipient(id, stranger);
        vm.expectRevert();
        v.sweep(id);
        vm.stopPrank();
        assertEq(address(v).balance, 1 ether);
        assertEq(stranger.balance, strangerBefore);
    }

    function testFuzz_unlockBoundary(uint32 offset) public {
        offset = uint32(bound(offset, 0, 10 * DAY));
        ScheduleVault v = _simple(1 ether, 10, 0, false);
        vm.warp(T0 + 10 * DAY - 1 - offset % (10 * DAY - 1 hours - 1)); // always strictly before unlock
        vm.expectRevert(ScheduleVault.NotExecutable.selector);
        v.execute(0);
        vm.prank(alice);
        vm.expectRevert(ScheduleVault.NotUnlocked.selector);
        v.claim(0);
    }
}
