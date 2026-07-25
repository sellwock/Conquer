"""Settlement: turning matched YES/NO inventory back into collateral.

This is what makes complement arbitrage a fast loop instead of a hold-to-resolution
trade. Holding one YES and one NO of the same condition is economically identical to
holding $1, and `mergePositions` makes that literal on demand — no waiting weeks for
the market to resolve, no resolution risk, and the capital immediately recycles into
the next opportunity.

Merging costs gas, and gas is a fixed cost per call, so merges are batched: the queue
accumulates pairs and settles when either enough value has built up or the inventory
has been sitting too long.

The on-chain call is isolated behind `Settler` for the same reason the CLOB is —
it could not be exercised from a sandboxed environment, so it is one small,
replaceable, clearly-marked surface.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Protocol

from .config import CTF_ADDRESS, ExecutionConfig
from .models import PairPosition

log = logging.getLogger(__name__)

# Binary conditions have two outcome slots; the partition is the pair of index sets.
BINARY_PARTITION = [1, 2]


class Settler(Protocol):
    def merge(self, condition_id: str, pairs: float, neg_risk: bool) -> str: ...

    def split(self, condition_id: str, pairs: float, neg_risk: bool) -> str: ...


class NullSettler:
    """No-op settler for paper and replay runs."""

    def __init__(self) -> None:
        self.merges: list[tuple[str, float]] = []
        self.splits: list[tuple[str, float]] = []

    def merge(self, condition_id: str, pairs: float, neg_risk: bool) -> str:
        self.merges.append((condition_id, pairs))
        return f"paper-merge-{len(self.merges)}"

    def split(self, condition_id: str, pairs: float, neg_risk: bool) -> str:
        self.splits.append((condition_id, pairs))
        return f"paper-split-{len(self.splits)}"


class SettlementQueue:
    """Tracks matched inventory and decides when paying gas is worth it."""

    def __init__(self, cfg: ExecutionConfig) -> None:
        self.cfg = cfg
        self.positions: dict[str, PairPosition] = {}
        self._first_seen: dict[str, float] = {}
        self.settled_pairs = 0.0
        self.gas_spent = 0.0

    def record(
        self,
        condition_id: str,
        *,
        yes_size: float,
        no_size: float,
        cost: float,
        neg_risk: bool = False,
        now: float | None = None,
    ) -> None:
        now = now if now is not None else time.time()
        pos = self.positions.get(condition_id)
        if pos is None:
            pos = PairPosition(condition_id=condition_id, neg_risk=neg_risk)
            self.positions[condition_id] = pos
            self._first_seen[condition_id] = now
        pos.yes_size += yes_size
        pos.no_size += no_size
        pos.cost_basis += cost

    def due(self, now: float | None = None) -> list[PairPosition]:
        """Positions worth settling: enough size to amortise gas, or old enough."""
        now = now if now is not None else time.time()
        out = []
        for cid, pos in self.positions.items():
            pairs = pos.mergeable
            if pairs <= 0:
                continue
            age = now - self._first_seen.get(cid, now)
            if pairs >= self.cfg.merge_threshold_pairs or age >= self.cfg.merge_max_age_s:
                out.append(pos)
        return out

    def settle(self, settler: Settler, now: float | None = None) -> list[tuple[str, float, str]]:
        """Merge everything that is due. Returns (condition_id, pairs, tx) per call."""
        results = []
        for pos in self.due(now):
            pairs = pos.mergeable
            try:
                tx = settler.merge(pos.condition_id, pairs, pos.neg_risk)
            except Exception as e:
                log.error("merge failed for %s: %s", pos.condition_id, e)
                continue
            pos.yes_size -= pairs
            pos.no_size -= pairs
            pos.cost_basis = 0.0 if pos.mergeable <= 1e-9 else pos.cost_basis
            self.settled_pairs += pairs
            results.append((pos.condition_id, pairs, tx))
            if pos.yes_size <= 1e-9 and pos.no_size <= 1e-9:
                self.positions.pop(pos.condition_id, None)
                self._first_seen.pop(pos.condition_id, None)
        return results

    def outstanding_pairs(self) -> float:
        return sum(p.mergeable for p in self.positions.values())

    def unmatched(self) -> dict[str, float]:
        """Leftover naked exposure per condition: positive is long YES, negative NO.

        Anything here means a leg went unhedged. It should normally be empty.
        """
        return {
            cid: p.yes_size - p.no_size
            for cid, p in self.positions.items()
            if abs(p.yes_size - p.no_size) > 1e-9
        }


class Web3Settler:
    """Calls `mergePositions` / `splitPosition` on the Conditional Tokens Framework.

    VERIFY (checked by `polyarb doctor` before live mode is permitted):
      * the collateral argument must be **pUSD** under CLOB V2, not USDC.e. The
        address is taken from config and is never hardcoded here.
      * neg-risk markets route through the NegRiskAdapter rather than the CTF
        directly; v1 excludes them from discovery, and this class refuses them
        rather than sending a call that would silently do the wrong thing.
    """

    # Minimal ABI — only what we call.
    CTF_ABI = [
        {
            "name": "mergePositions",
            "type": "function",
            "stateMutability": "nonpayable",
            "inputs": [
                {"name": "collateralToken", "type": "address"},
                {"name": "parentCollectionId", "type": "bytes32"},
                {"name": "conditionId", "type": "bytes32"},
                {"name": "partition", "type": "uint256[]"},
                {"name": "amount", "type": "uint256"},
            ],
            "outputs": [],
        },
        {
            "name": "splitPosition",
            "type": "function",
            "stateMutability": "nonpayable",
            "inputs": [
                {"name": "collateralToken", "type": "address"},
                {"name": "parentCollectionId", "type": "bytes32"},
                {"name": "conditionId", "type": "bytes32"},
                {"name": "partition", "type": "uint256[]"},
                {"name": "amount", "type": "uint256"},
            ],
            "outputs": [],
        },
    ]

    ZERO_BYTES32 = "0x" + "00" * 32
    COLLATERAL_DECIMALS = 6  # pUSD, same as USDC on Polygon

    def __init__(self, rpc_url: str, private_key: str, collateral_address: str,
                 ctf_address: str = CTF_ADDRESS) -> None:
        if not collateral_address:
            raise RuntimeError(
                "collateral (pUSD) address is not configured; run `polyarb doctor` "
                "to resolve it before enabling live settlement"
            )
        try:
            from web3 import Web3  # type: ignore
        except ImportError as e:  # pragma: no cover - optional extra
            raise RuntimeError("web3 is required for settlement: pip install -e '.[live]'") from e

        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = self.w3.eth.account.from_key(private_key)
        self.collateral = self.w3.to_checksum_address(collateral_address)
        self.ctf = self.w3.eth.contract(
            address=self.w3.to_checksum_address(ctf_address), abi=self.CTF_ABI
        )

    def _amount(self, pairs: float) -> int:
        return int(round(pairs * 10**self.COLLATERAL_DECIMALS))

    def merge(self, condition_id: str, pairs: float, neg_risk: bool) -> str:
        return self._send("mergePositions", condition_id, pairs, neg_risk)

    def split(self, condition_id: str, pairs: float, neg_risk: bool) -> str:
        return self._send("splitPosition", condition_id, pairs, neg_risk)

    def _send(self, fn_name: str, condition_id: str, pairs: float, neg_risk: bool) -> str:
        if neg_risk:
            raise NotImplementedError(
                "neg-risk conditions settle through the NegRiskAdapter, not the CTF; "
                "they are excluded from v1 discovery"
            )
        fn = getattr(self.ctf.functions, fn_name)(
            self.collateral,
            self.ZERO_BYTES32,
            condition_id,
            BINARY_PARTITION,
            self._amount(pairs),
        )
        tx = fn.build_transaction(
            {
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "chainId": 137,
            }
        )
        signed = self.account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
        tx_hash = self.w3.eth.send_raw_transaction(raw)
        return tx_hash.hex()

    def collateral_balance(self) -> float:
        """pUSD balance of the trading account, in whole units."""
        erc20_abi: list[dict[str, Any]] = [
            {
                "name": "balanceOf",
                "type": "function",
                "stateMutability": "view",
                "inputs": [{"name": "account", "type": "address"}],
                "outputs": [{"name": "", "type": "uint256"}],
            }
        ]
        token = self.w3.eth.contract(address=self.collateral, abi=erc20_abi)
        raw = token.functions.balanceOf(self.account.address).call()
        return raw / 10**self.COLLATERAL_DECIMALS
