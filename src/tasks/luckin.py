"""Luckin Coffee ordering — wraps the `luckin` CLI for programmatic access.

This module encapsulates calls to Luckin's official CLI tool
(https://open.lkcoffee.com) for store lookup, menu browsing,
order preview, and order creation.

CLI reference (luckin 0.0.1):
  luckin store <lat> <lng> [query]
  luckin menu <deptId> [keyword]
  luckin product <deptId> [keyword]
  luckin order preview <deptId> -p productId:skuCode[:amount]
  luckin order create <deptId> --lat <lat> --lng <lng> -p productId:skuCode[:amount] [--coupon <code>]
  luckin order detail <orderId>
  luckin order cancel <orderId>
  luckin login
  luckin logout
"""

import asyncio
import json
import logging
import re
import shlex
from dataclasses import dataclass, field
from typing import Literal

from src.config import LUCKIN_BINARY_PATH

logger = logging.getLogger(__name__)


# ── Data types ──────────────────────────────────────────────────────────────


@dataclass
class LuckinStore:
    """A nearby Luckin Coffee store."""
    dept_id: str
    name: str
    address: str
    distance: str | None = None
    raw: str = ""


@dataclass
class LuckinProduct:
    """A product / drink on the menu."""
    product_id: str
    name: str
    price: str | None = None
    sku_code: str | None = None
    sku_name: str | None = None
    raw: str = ""


@dataclass
class OrderItem:
    """One line-item in an order."""
    product_id: str
    sku_code: str
    amount: int = 1


@dataclass
class OrderPreview:
    """Result of a preview-order call."""
    items: list[dict] = field(default_factory=list)
    total: str | None = None
    raw: str = ""


@dataclass
class OrderResult:
    """Result of creating an order."""
    success: bool
    order_id: str | None = None
    pick_code: str | None = None
    message: str = ""


# ── Client ──────────────────────────────────────────────────────────────────


class LuckinClient:
    """Wrapper around the `luckin` CLI binary.

    All methods raise ``LuckinError`` on non-zero exit or parse failure.
    """

    def __init__(self, binary: str | None = None):
        self._binary = binary or LUCKIN_BINARY_PATH

    # ── Helpers ──────────────────────────────────────────────────────────

    async def _run(self, *args: str, timeout: int = 20) -> str:
        """Run a luckin CLI subcommand and return stdout."""
        cmd = [self._binary, *args]
        logger.debug("Running: %s", shlex.join(cmd))
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except FileNotFoundError:
            raise LuckinError(
                f"未找到 luckin CLI ({self._binary})。请先安装：\n"
                "  Windows: irm https://open.lkcoffee.com/window/install | iex\n"
                "  Mac/Linux: curl -fsSL https://open.lkcoffee.com/install | bash"
            )
        except asyncio.TimeoutError:
            raise LuckinError(f"luckin CLI 超时（> {timeout}s）")

        text = stdout.decode("utf-8", errors="replace").strip()
        err_text = stderr.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0:
            msg = err_text or text or f"退出码 {proc.returncode}"
            raise LuckinError(f"luckin 命令失败: {msg}")

        return text

    # ── Auth ──────────────────────────────────────────────────────────────

    async def check_login(self) -> bool:
        """Check whether the user is logged in by running a lightweight command."""
        try:
            await self._run("config")
            return True
        except LuckinError:
            return False

    # ── Store lookup ──────────────────────────────────────────────────────

    async def find_store(self, lat: float, lng: float, query: str | None = None) -> list[LuckinStore]:
        """Find nearby Luckin stores.

        Args:
            lat: Latitude.
            lng: Longitude.
            query: Optional store name or keyword filter.

        Returns:
            List of matching stores.
        """
        args = ["store", str(lat), str(lng)]
        if query:
            args.append(query)
        text = await self._run(*args)
        return self._parse_stores(text)

    def _parse_stores(self, text: str) -> list[LuckinStore]:
        """Parse luckin store output into structured results."""
        stores: list[LuckinStore] = []
        # Try JSON first
        try:
            data = json.loads(text)
            if isinstance(data, list):
                for item in data:
                    stores.append(LuckinStore(
                        dept_id=str(item.get("deptId", item.get("id", ""))),
                        name=item.get("name", ""),
                        address=item.get("address", ""),
                        distance=item.get("distance", ""),
                        raw=json.dumps(item, ensure_ascii=False),
                    ))
                return stores
        except json.JSONDecodeError:
            pass

        # Fallback: line-by-line parsing
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            # Try to extract deptId from various formats
            # Pattern: "门店名称 (ID: 12345)"
            m = re.search(r'ID[：:]\s*(\d+)', line)
            if m:
                stores.append(LuckinStore(
                    dept_id=m.group(1),
                    name=line[:50],
                    raw=line,
                ))
        return stores

    # ── Menu / product ────────────────────────────────────────────────────

    async def get_menu(self, dept_id: str, keyword: str | None = None) -> list[LuckinProduct]:
        """Search the menu of a store.

        Args:
            dept_id: Store's department ID.
            keyword: Optional search term (e.g. "生椰拿铁").

        Returns:
            List of matching products.
        """
        args = ["menu", dept_id]
        if keyword:
            args.append(keyword)
        text = await self._run(*args)
        return self._parse_products(text)

    async def get_products(self, dept_id: str, keyword: str | None = None) -> list[LuckinProduct]:
        """Search products of a store (more detailed than menu)."""
        args = ["product", dept_id]
        if keyword:
            args.append(keyword)
        text = await self._run(*args)
        return self._parse_products(text)

    def _parse_products(self, text: str) -> list[LuckinProduct]:
        """Parse luckin menu/product output into structured results."""
        products: list[LuckinProduct] = []
        try:
            data = json.loads(text)
            items = data if isinstance(data, list) else data.get("list", data.get("products", [data]))
            for item in items:
                sku_code = str(item.get("skuCode", item.get("sku", "")))
                products.append(LuckinProduct(
                    product_id=str(item.get("productId", item.get("id", ""))),
                    name=item.get("name", item.get("productName", "")),
                    price=str(item.get("price", item.get("salePrice", ""))),
                    sku_code=sku_code,
                    sku_name=item.get("skuName", ""),
                    raw=json.dumps(item, ensure_ascii=False),
                ))
            return products
        except json.JSONDecodeError:
            pass

        # Fallback line-by-line
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            products.append(LuckinProduct(
                product_id="",
                name=line[:80],
                raw=line,
            ))
        return products

    # ── Order preview ─────────────────────────────────────────────────────

    async def preview_order(self, dept_id: str, items: list[OrderItem]) -> OrderPreview:
        """Preview an order before placing it.

        Args:
            dept_id: Store ID.
            items: List of (productId, skuCode, amount).

        Returns:
            Preview details.
        """
        args = ["order", "preview", dept_id]
        for item in items:
            args.extend(["-p", f"{item.product_id}:{item.sku_code}:{item.amount}"])
        text = await self._run(*args)
        return OrderPreview(raw=text)

    # ── Order create ──────────────────────────────────────────────────────

    async def create_order(
        self,
        dept_id: str,
        lat: float,
        lng: float,
        items: list[OrderItem],
        coupon: str | None = None,
    ) -> OrderResult:
        """Place an order.

        Args:
            dept_id: Store ID.
            lat: User's latitude.
            lng: User's longitude.
            items: Items to order.
            coupon: Optional coupon code.

        Returns:
            Order result with order_id and pick_code.
        """
        args = [
            "order", "create", dept_id,
            "--lat", str(lat),
            "--lng", str(lng),
        ]
        for item in items:
            args.extend(["-p", f"{item.product_id}:{item.sku_code}:{item.amount}"])
        if coupon:
            args.extend(["--coupon", coupon])

        text = await self._run(*args)

        # Try to parse order_id and pick code from output
        order_id = None
        pick_code = None

        m = re.search(r'order[Ii][Dd][：:]\s*(\S+)', text)
        if m:
            order_id = m.group(1)

        m = re.search(r'(取餐码|取餐号|pick.?code)[：:]\s*(\S+)', text)
        if m:
            pick_code = m.group(2)

        success = order_id is not None or "成功" in text or "下单" in text
        return OrderResult(
            success=success,
            order_id=order_id,
            pick_code=pick_code,
            message=text[:300],
        )

    # ── Order manage ──────────────────────────────────────────────────────

    async def get_order_detail(self, order_id: str) -> str:
        """Get order details."""
        return await self._run("order", "detail", order_id)

    async def cancel_order(self, order_id: str) -> str:
        """Cancel an order."""
        return await self._run("order", "cancel", order_id)


# ── Error ───────────────────────────────────────────────────────────────────


class LuckinError(Exception):
    """Raised when a luckin CLI call fails."""
    pass
