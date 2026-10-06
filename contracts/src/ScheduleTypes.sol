// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What a tranche delivers.
enum Kind {
    Native, // MON
    ERC20,
    ERC721
}

/// @notice Lifecycle of one tranche. Delivered, Swept and Cancelled are terminal.
enum Status {
    Pending, // waiting for unlockTime, or unlocked but not yet delivered
    Delivered, // reached the recipient
    Claimable, // a push failed; the recipient can still claim()
    Swept, // unclaimed for SWEEP_GRACE; sent to fallback/creator
    Cancelled // creator cancelled before unlock; returned to creator
}

/// @notice Lifecycle of the whole schedule.
enum State {
    AwaitingFunds,
    Active,
    Closed
}

/// @notice Caller-supplied description of one tranche.
/// @dev `amountOrId` is the amount for Native/ERC20 and the token id for ERC721.
///      `token` is address(0) for Native.
struct TrancheInput {
    address recipient;
    Kind kind;
    address token;
    uint256 amountOrId;
    uint64 unlockTime;
}

/// @dev Packs into two storage slots plus one for `amountOrId`.
struct Tranche {
    address recipient;
    uint64 unlockTime;
    Kind kind;
    Status status;
    address token;
    uint256 amountOrId;
}

/// @notice Parameters shared by the whole schedule.
struct ScheduleParams {
    address fallbackRecipient; // receives swept funds; address(0) means the creator
    bool revocable; // creator may cancel (with a timelock) before unlock
    uint64 fundingWindow; // seconds the schedule may wait for funding
    uint96 tipPerExecution; // native tip paid to whoever executes each tranche
    bytes32 salt; // makes the vault address predictable for the creator
    uint64 validatorId; // 0 = idle schedule; otherwise stake native tranches with this (allowlisted) validator
}
