// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ScheduleVault} from "./ScheduleVault.sol";
import {Kind, TrancheInput, ScheduleParams} from "./ScheduleTypes.sol";

/// @title ScheduleFactory
/// @notice Deploys one ScheduleVault clone per schedule. Holds no funds and has no owner;
///         its only configuration is immutable and set at deployment.
/// @dev Users approve this factory (a fixed address) once, so the UI never needs a
///      per-schedule approval. The factory only ever pulls from `msg.sender` into the vault
///      it just created.
contract ScheduleFactory {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    /// @notice Bounds for the funding window. The mainnet deployment uses >= 1 hour; the demo
    ///         deployment uses seconds so a real execution can be shown in a video.
    uint64 public immutable MIN_FUNDING_WINDOW;
    uint64 public immutable MAX_FUNDING_WINDOW;
    uint96 public immutable MAX_TIP;

    event ScheduleCreated(
        address indexed vault,
        address indexed creator,
        uint256 trancheCount,
        bool revocable,
        uint64 fundingDeadline,
        bool funded
    );

    error BadFundingWindow();
    error TipTooHigh();
    error WrongNativeAmount();

    constructor(uint64 minWindow_, uint64 maxWindow_, uint96 maxTip_) {
        require(minWindow_ > 0 && minWindow_ <= maxWindow_, "bad window bounds");
        implementation = address(new ScheduleVault());
        MIN_FUNDING_WINDOW = minWindow_;
        MAX_FUNDING_WINDOW = maxWindow_;
        MAX_TIP = maxTip_;
    }

    /// @notice Create a schedule.
    /// @param fundNow true: pull ERC-20/721 from the caller and activate in this transaction
    ///        (`msg.value` must then equal tip reserve + native tranches exactly).
    ///        false: create a draft that stays AwaitingFunds until its address is funded by any
    ///        means (e.g. an Aurora intent landing on Monad) and someone calls `activate()`.
    function create(ScheduleParams calldata p, TrancheInput[] calldata tranches, bool fundNow)
        external
        payable
        returns (address vault)
    {
        if (p.fundingWindow < MIN_FUNDING_WINDOW || p.fundingWindow > MAX_FUNDING_WINDOW) {
            revert BadFundingWindow();
        }
        if (p.tipPerExecution > MAX_TIP) revert TipTooHigh();
        uint64 deadline = uint64(block.timestamp) + p.fundingWindow;

        vault = Clones.cloneDeterministic(implementation, _salt(msg.sender, p.salt));
        ScheduleVault(payable(vault)).initialize{value: msg.value}(
            msg.sender, p.fallbackRecipient, p.revocable, deadline, p.tipPerExecution, tranches
        );

        if (fundNow) {
            uint256 nativeTotal = uint256(p.tipPerExecution) * tranches.length;
            for (uint256 i = 0; i < tranches.length; i++) {
                TrancheInput calldata x = tranches[i];
                if (x.kind == Kind.Native) {
                    nativeTotal += x.amountOrId;
                } else if (x.kind == Kind.ERC20) {
                    IERC20(x.token).safeTransferFrom(msg.sender, vault, x.amountOrId);
                } else {
                    IERC721(x.token).transferFrom(msg.sender, vault, x.amountOrId);
                }
            }
            if (msg.value != nativeTotal) revert WrongNativeAmount();
            ScheduleVault(payable(vault)).activate(); // reverts if anything is short
        }

        emit ScheduleCreated(vault, msg.sender, tranches.length, p.revocable, deadline, fundNow);
    }

    /// @notice The address a schedule will have. Lets a UI request a bridge quote or show the
    ///         deposit target before the creation transaction is sent.
    function predict(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(creator, salt), address(this));
    }

    function _salt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
