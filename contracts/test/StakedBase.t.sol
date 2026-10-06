// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {ScheduleFactory} from "../src/ScheduleFactory.sol";
import {ScheduleVault} from "../src/ScheduleVault.sol";
import {StakedScheduleVault} from "../src/StakedScheduleVault.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {Kind, Status, State, TrancheInput, ScheduleParams} from "../src/ScheduleTypes.sol";

/// @dev Fixtures for staked schedules: a mock precompile etched at 0x1000 and a factory that
///      allows validator 7.
abstract contract StakedBase is Base {
    address internal constant STAKING = address(0x1000);
    uint64 internal constant VAL = 7;
    uint256 internal constant PREPARE_LEAD = 48 hours;

    MockStaking internal stk;
    address internal keeper2 = makeAddr("keeper2");

    function setUp() public virtual override {
        super.setUp();
        vm.etch(STAKING, address(new MockStaking()).code);
        stk = MockStaking(payable(STAKING));
        stk.addValidator(VAL);
        stk.setEpoch(100);

        uint64[] memory vals = new uint64[](1);
        vals[0] = VAL;
        f = new ScheduleFactory(60, 30 days, 1 ether, PREPARE_LEAD, feeSink, vals);
        vm.startPrank(creator);
        tok.approve(address(f), type(uint256).max);
        nft.setApprovalForAll(address(f), true);
        vm.stopPrank();
    }

    function _sp(uint96 tip, address fb_) internal returns (ScheduleParams memory p) {
        p = _p(false, fb_, tip);
        p.validatorId = VAL;
    }

    /// @dev Native value a staked fundNow create needs: 3 tip slots per tranche + native principal.
    function _stakedValue(TrancheInput[] memory ins, uint96 tip) internal pure returns (uint256 v) {
        v = uint256(tip) * ins.length * 3;
        for (uint256 i = 0; i < ins.length; i++) {
            if (ins[i].kind == Kind.Native) v += ins[i].amountOrId;
        }
    }

    function _makeStaked(TrancheInput[] memory ins, ScheduleParams memory p, bool fund)
        internal
        returns (StakedScheduleVault v)
    {
        uint256 value = fund ? _stakedValue(ins, p.tipPerExecution) : uint256(p.tipPerExecution) * ins.length * 3;
        vm.prank(creator);
        v = StakedScheduleVault(payable(f.create{value: value}(p, ins, fund)));
    }

    /// @dev One staked native tranche for alice unlocking in `days_` days.
    function _stakedOne(uint256 amount, uint64 days_, uint96 tip) internal returns (StakedScheduleVault v) {
        v = _makeStaked(_one(_native(alice, amount, T0 + days_ * DAY)), _sp(tip, address(0)), true);
    }

    function _reward(address vault, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        stk.accrue{value: amount}(VAL, vault);
    }

    function _stage(StakedScheduleVault v, uint256 id) internal view returns (StakedScheduleVault.Stage) {
        return v.stage(id);
    }
}
