// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {ScheduleFactory} from "../src/ScheduleFactory.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {Kind, Status, State, TrancheInput, ScheduleParams} from "../src/ScheduleTypes.sol";

contract ScheduleFactoryTest is Base {
    function test_config_isImmutableAndReadable() public view {
        assertEq(f.MIN_FUNDING_WINDOW(), 60);
        assertEq(f.MAX_FUNDING_WINDOW(), 30 days);
        assertEq(f.MAX_TIP(), 1 ether);
        assertTrue(f.implementation().code.length > 0);
    }

    function test_constructor_rejectsBadBounds() public {
        vm.expectRevert();
        new ScheduleFactory(0, 10, 1, 1 days, address(0), new uint64[](0));
        vm.expectRevert();
        new ScheduleFactory(20, 10, 1, 1 days, address(0), new uint64[](0));
    }

    function test_fundingWindow_bounds() public {
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + 40 days));
        ScheduleParams memory p = _p(false, address(0), 0);
        p.fundingWindow = 59;
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.BadFundingWindow.selector);
        f.create{value: 1 ether}(p, ins, true);
        p.fundingWindow = 30 days + 1;
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.BadFundingWindow.selector);
        f.create{value: 1 ether}(p, ins, true);
        p.fundingWindow = 60; // lower bound ok (unlock is far later)
        vm.prank(creator);
        f.create{value: 1 ether}(p, ins, true);
    }

    function test_tip_capped() public {
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        ScheduleParams memory p = _p(false, address(0), 1 ether + 1);
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.TipTooHigh.selector);
        f.create{value: 3 ether}(p, ins, true);
    }

    function test_fundNow_requiresExactNativeValue() public {
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        ScheduleParams memory p = _p(false, address(0), 0.1 ether);
        vm.prank(creator);
        vm.expectRevert(ScheduleFactory.WrongNativeAmount.selector);
        f.create{value: 1.2 ether}(p, ins, true); // 0.1 too much
        vm.prank(creator);
        vm.expectRevert(); // too little: tip reserve ok but native tranche short -> underfunded
        f.create{value: 1 ether}(p, ins, true);
    }

    function test_predict_matchesActualAddress() public {
        ScheduleParams memory p = _p(false, address(0), 0);
        address predicted = f.predict(creator, p.salt, false);
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        vm.prank(creator);
        address actual = f.create{value: 1 ether}(p, ins, true);
        assertEq(predicted, actual);
    }

    function test_predict_isPerCreator() public view {
        assertTrue(f.predict(creator, bytes32(uint256(1)), false) != f.predict(alice, bytes32(uint256(1)), false));
    }

    function test_sameSalt_sameCreator_reverts_butOtherCreatorOk() public {
        ScheduleParams memory p = _p(false, address(0), 0);
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        vm.prank(creator);
        f.create{value: 1 ether}(p, ins, true);
        vm.prank(creator);
        vm.expectRevert();
        f.create{value: 1 ether}(p, ins, true);
        vm.deal(bob, 5 ether);
        vm.prank(bob);
        f.create{value: 1 ether}(p, ins, true); // different creator, same salt: different address
    }

    /// The pre-funded-address path: assets sent to the predicted address BEFORE the vault exists
    /// (what a bridge delivery would do) are recognised once the schedule is created.
    function test_counterfactualFunding_thenCreateThenActivate() public {
        ScheduleParams memory p = _p(false, address(0), 0);
        address predicted = f.predict(creator, p.salt, false);
        vm.prank(creator);
        tok.transfer(predicted, 5 ether); // lands on an address with no code yet
        TrancheInput[] memory ins = _one(_erc20(alice, address(tok), 5 ether, T0 + DAY));
        vm.prank(creator);
        ScheduleVault v = ScheduleVault(payable(f.create(p, ins, false)));
        assertEq(address(v), predicted);
        v.activate();
        vm.warp(T0 + DAY);
        v.execute(0);
        assertEq(tok.balanceOf(alice), 5 ether);
    }

    function test_event_emitted() public {
        ScheduleParams memory p = _p(true, fb, 0);
        address predicted = f.predict(creator, p.salt, false);
        TrancheInput[] memory ins = _one(_native(alice, 1 ether, T0 + DAY));
        vm.expectEmit(true, true, false, true, address(f));
        emit ScheduleFactory.ScheduleCreated(predicted, creator, 1, true, T0 + 1 hours, true, false);
        vm.prank(creator);
        f.create{value: 1 ether}(p, ins, true);
    }

    function test_factory_holdsNoFunds_afterCreate() public {
        TrancheInput[] memory ins = new TrancheInput[](3);
        ins[0] = _native(alice, 1 ether, T0 + DAY);
        ins[1] = _erc20(alice, address(tok), 2 ether, T0 + DAY);
        ins[2] = _nft(alice, address(nft), 9, T0 + DAY);
        ScheduleVault v = _make(ins, _p(false, address(0), 0.01 ether), true);
        assertEq(address(f).balance, 0);
        assertEq(tok.balanceOf(address(f)), 0);
        assertEq(nft.ownerOf(9), address(v));
    }

    function test_factory_onlyPullsFromCaller() public {
        // alice approved the factory, creator did not set up for alice's tokens: a third party
        // cannot make the factory spend alice's tokens.
        tok.mint(alice, 10 ether);
        vm.prank(alice);
        tok.approve(address(f), type(uint256).max);
        TrancheInput[] memory ins = _one(_erc20(bob, address(tok), 10 ether, T0 + DAY));
        ScheduleParams memory p = _p(false, address(0), 0);
        uint256 aliceBefore = tok.balanceOf(alice);
        vm.prank(creator);
        f.create(p, ins, true); // pulls from creator (msg.sender) only
        assertEq(tok.balanceOf(alice), aliceBefore);
    }
}
