// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ScheduleFactory} from "../src/ScheduleFactory.sol";

/// @notice Deploys the factory (and, through it, both vault implementations).
/// @dev Configuration comes from the environment so nothing is hard-coded per network:
///      MIN_FUNDING_WINDOW, MAX_FUNDING_WINDOW (seconds), MAX_TIP (wei), PREPARE_LEAD (seconds),
///      FEE_RECIPIENT (address, may be 0), VALIDATOR_IDS (comma-separated, may be empty).
///      Mainnet-like:  60*60, 30 days, 0.5 ether, 48 hours.
///      Demo network:  60, 30 days, 0.5 ether, 48 hours (staked schedules still need >= 3 days).
///
///      forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
contract Deploy is Script {
    function run() external returns (ScheduleFactory f) {
        uint64 minW = uint64(vm.envOr("MIN_FUNDING_WINDOW", uint256(1 hours)));
        uint64 maxW = uint64(vm.envOr("MAX_FUNDING_WINDOW", uint256(30 days)));
        uint96 maxTip = uint96(vm.envOr("MAX_TIP", uint256(0.5 ether)));
        uint256 lead = vm.envOr("PREPARE_LEAD", uint256(48 hours));
        address feeTo = vm.envOr("FEE_RECIPIENT", address(0));
        uint256[] memory raw = vm.envOr("VALIDATOR_IDS", ",", new uint256[](0));
        uint64[] memory vals = new uint64[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            vals[i] = uint64(raw[i]);
        }

        vm.startBroadcast();
        f = new ScheduleFactory(minW, maxW, maxTip, lead, feeTo, vals);
        vm.stopBroadcast();

        console2.log("ScheduleFactory", address(f));
        console2.log("  idle implementation  ", f.implementation());
        console2.log("  staked implementation", f.stakedImplementation());
    }
}
