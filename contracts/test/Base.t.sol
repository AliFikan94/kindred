// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ScheduleFactory} from "../src/ScheduleFactory.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {Kind, Status, State, TrancheInput, Tranche, ScheduleParams} from "../src/ScheduleTypes.sol";
import {TestERC20, TestERC721} from "./mocks/Mocks.sol";

/// @dev Shared fixtures for the vault test suites.
abstract contract Base is Test {
    uint64 internal constant T0 = 1_700_000_000;
    uint64 internal constant DAY = 1 days;

    ScheduleFactory internal f;
    TestERC20 internal tok;
    TestERC721 internal nft;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");
    address internal fb = makeAddr("fallback");

    uint256 internal salts;

    function setUp() public virtual {
        vm.warp(T0);
        f = new ScheduleFactory(60, 30 days, 1 ether);
        tok = new TestERC20();
        nft = new TestERC721();
        vm.deal(creator, 10_000 ether);
        tok.mint(creator, 1_000_000 ether);
        for (uint256 i = 1; i <= 10; i++) {
            nft.mint(creator, i);
        }
        vm.startPrank(creator);
        tok.approve(address(f), type(uint256).max);
        nft.setApprovalForAll(address(f), true);
        vm.stopPrank();
    }

    // ---- builders
    function _p(bool revocable, address fallback_, uint96 tip) internal returns (ScheduleParams memory) {
        return ScheduleParams({
            fallbackRecipient: fallback_,
            revocable: revocable,
            fundingWindow: 1 hours,
            tipPerExecution: tip,
            salt: bytes32(++salts)
        });
    }

    function _native(address r, uint256 a, uint64 u) internal pure returns (TrancheInput memory) {
        return TrancheInput({recipient: r, kind: Kind.Native, token: address(0), amountOrId: a, unlockTime: u});
    }

    function _erc20(address r, address t, uint256 a, uint64 u) internal pure returns (TrancheInput memory) {
        return TrancheInput({recipient: r, kind: Kind.ERC20, token: t, amountOrId: a, unlockTime: u});
    }

    function _nft(address r, address t, uint256 id, uint64 u) internal pure returns (TrancheInput memory) {
        return TrancheInput({recipient: r, kind: Kind.ERC721, token: t, amountOrId: id, unlockTime: u});
    }

    function _one(TrancheInput memory a) internal pure returns (TrancheInput[] memory r) {
        r = new TrancheInput[](1);
        r[0] = a;
    }

    function _two(TrancheInput memory a, TrancheInput memory b) internal pure returns (TrancheInput[] memory r) {
        r = new TrancheInput[](2);
        r[0] = a;
        r[1] = b;
    }

    function _nativeValue(TrancheInput[] memory ins, uint96 tip) internal pure returns (uint256 v) {
        v = uint256(tip) * ins.length;
        for (uint256 i = 0; i < ins.length; i++) {
            if (ins[i].kind == Kind.Native) v += ins[i].amountOrId;
        }
    }

    /// @dev Creates and (if fund) funds a schedule from `creator`.
    function _make(TrancheInput[] memory ins, ScheduleParams memory p, bool fund) internal returns (ScheduleVault v) {
        uint256 value = fund ? _nativeValue(ins, p.tipPerExecution) : uint256(p.tipPerExecution) * ins.length;
        vm.prank(creator);
        v = ScheduleVault(payable(f.create{value: value}(p, ins, fund)));
    }

    /// @dev One funded native tranche for alice unlocking in `days_` days.
    function _simple(uint256 amount, uint64 days_, uint96 tip, bool revocable) internal returns (ScheduleVault v) {
        v = _make(_one(_native(alice, amount, T0 + days_ * DAY)), _p(revocable, address(0), tip), true);
    }

    function _status(ScheduleVault v, uint256 id) internal view returns (Status) {
        return v.tranche(id).status;
    }
}
