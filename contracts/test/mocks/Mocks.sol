// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract TestERC20 is ERC20 {
    constructor() ERC20("Test", "TST") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev USDT-style: transfer returns nothing.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 a) external {
        allowance[msg.sender][s] = a;
    }

    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }

    function transferFrom(address f, address to, uint256 a) external {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

/// @dev Takes 10% on every transfer: must not be accepted as funding.
contract FeeERC20 is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev USDC-style blocklist: transfers to a blocked address revert.
contract BlocklistERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Block", "BLK") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @dev Returns false instead of reverting.
contract FalseReturnERC20 is ERC20 {
    bool public failing;

    constructor() ERC20("False", "FLS") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setFailing(bool f) external {
        failing = f;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (failing) return false;
        return super.transfer(to, v);
    }
}

contract TestERC721 is ERC721 {
    constructor() ERC721("NFT", "NFT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev Rejects native currency and NFTs.
contract Rejector is IERC721Receiver {
    receive() external payable {
        revert("no");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no");
    }

    function doClaim(address vault, uint256 id) external {
        (bool ok, bytes memory ret) = vault.call(abi.encodeWithSignature("claim(uint256)", id));
        if (!ok) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
    }
}

/// @dev Burns all gas it is given on receive.
contract GasBurner is IERC721Receiver {
    uint256 public sink;

    receive() external payable {
        while (true) {
            sink++;
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        while (true) {
            sink++;
        }
    }
}

/// @dev Tries to re-enter the vault from its receive hook.
contract Reentrant {
    address public vault;
    uint256 public id;
    bool public reentered;
    bool public reenterSucceeded;
    bool public dueSeenDuringReceive = true; // stays true if never observed
    bool public observed;

    function arm(address v, uint256 i) external {
        vault = v;
        id = i;
    }

    receive() external payable {
        if (vault != address(0) && !reentered) {
            reentered = true;
            (bool okv, bytes memory ret) = vault.staticcall(abi.encodeWithSignature("isDue(uint256)", id));
            if (okv) {
                observed = true;
                dueSeenDuringReceive = abi.decode(ret, (bool));
            }
            (bool ok,) = vault.call(abi.encodeWithSignature("claim(uint256)", id));
            (bool ok2,) = vault.call(abi.encodeWithSignature("execute(uint256)", id));
            reenterSucceeded = ok || ok2;
        }
    }

    function doClaim(address v, uint256 i) external {
        (bool ok,) = v.call(abi.encodeWithSignature("claim(uint256)", i));
        require(ok, "claim failed");
    }
}

/// @dev Plain contract with no ERC721 receiver hook and a payable receive (for ERC721 tests).
contract NoHook {
    receive() external payable {}
}

/// @dev A keeper that cannot receive its tip.
contract BadKeeper {
    function run(address vault, uint256 id) external {
        (bool ok,) = vault.call(abi.encodeWithSignature("execute(uint256)", id));
        require(ok, "exec failed");
    }

    receive() external payable {
        revert("no tip");
    }
}
