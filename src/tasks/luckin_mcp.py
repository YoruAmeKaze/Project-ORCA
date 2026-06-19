"""Luckin Coffee MCP Client — wraps the Luckin MCP Server via JSON-RPC.

MCP Server: https://gwmcp.lkcoffee.com/order/user/mcp
Auth: Bearer token
Protocol: streamable-http JSON-RPC 2.0
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from src.config import LUCKIN_MCP_URL, LUCKIN_MCP_TOKEN

logger = logging.getLogger(__name__)

MCP_URL = LUCKIN_MCP_URL or "https://gwmcp.lkcoffee.com/order/user/mcp"


class LuckinMCPClient:
    """JSON-RPC client for the Luckin Coffee MCP Server."""

    def __init__(self):
        self._http = httpx.AsyncClient(timeout=20.0)
        self._headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {LUCKIN_MCP_TOKEN}",
        }

    async def _call(self, tool: str, args: dict) -> dict:
        """Call an MCP tool and return the result."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool,
                "arguments": args,
            },
        }
        logger.debug("Luckin MCP call: %s %s", tool, args)
        try:
            resp = await self._http.post(
                MCP_URL, json=payload, headers=self._headers
            )
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                err = data["error"]
                raise RuntimeError(f"Luckin MCP error: {err.get('message', str(err))}")
            return data.get("result", {})
        except httpx.TimeoutException:
            raise RuntimeError("Luckin MCP 超时")
        except httpx.HTTPError as e:
            raise RuntimeError(f"Luckin MCP HTTP 错误: {e}")

    async def close(self):
        await self._http.aclose()

    # ── MCP tools ────────────────────────────────────────────────────────

    async def query_shop_list(self, latitude: float, longitude: float, dept_name: str | None = None) -> list[dict]:
        """查询附近门店."""
        args = {"latitude": latitude, "longitude": longitude}
        if dept_name:
            args["deptName"] = dept_name
        result = await self._call("queryShopList", args)
        content = self._extract_content(result)
        return self._parse_json_list(content)

    async def search_product(self, dept_id: int, query: str) -> list[dict]:
        """搜索商品."""
        result = await self._call("searchProductForMcp", {
            "deptId": dept_id,
            "query": query,
        })
        content = self._extract_content(result)
        return self._parse_json_list(content)

    async def get_product_detail(self, dept_id: int, product_id: int) -> dict:
        """查询商品详情."""
        result = await self._call("queryProductDetailInfo", {
            "deptId": dept_id,
            "productId": product_id,
        })
        content = self._extract_content(result)
        return self._parse_json(content)

    async def preview_order(self, dept_id: int, items: list[dict]) -> dict:
        """预览订单."""
        result = await self._call("previewOrder", {
            "deptId": dept_id,
            "productList": items,
        })
        content = self._extract_content(result)
        return self._parse_json(content)

    async def create_order(self, dept_id: int, items: list[dict],
                          latitude: float, longitude: float,
                          coupon_codes: list[str] | None = None,
                          remark: str | None = None) -> dict:
        """创建订单."""
        args = {
            "deptId": dept_id,
            "productList": items,
            "latitude": latitude,
            "longitude": longitude,
        }
        if coupon_codes:
            args["couponCodeList"] = coupon_codes
        if remark:
            args["remark"] = remark
        result = await self._call("createOrder", args)
        content = self._extract_content(result)
        return self._parse_json(content)

    async def switch_product(self, dept_id: int, product_id: int, sku_code: str,
                             attribute_id: int, sub_attribute_id: int,
                             amount: int = 1) -> dict:
        """切换商品规格选项，返回切换后的 SKU 编码和属性列表."""
        result = await self._call("switchProduct", {
            "deptId": dept_id,
            "productId": product_id,
            "skuCode": sku_code,
            "attrOperationParam": {
                "attributeId": attribute_id,
                "subAttr": {"attributeId": sub_attribute_id, "operation": 3},
            },
            "amount": amount,
        })
        content = self._extract_content(result)
        return self._parse_json(content)

    async def query_order_detail(self, order_id: str) -> dict:
        """查询订单详情."""
        result = await self._call("queryOrderDetailInfo", {
            "orderId": order_id,
        })
        content = self._extract_content(result)
        return self._parse_json(content)

    async def cancel_order(self, order_id: str) -> dict:
        """取消订单."""
        result = await self._call("cancelOrder", {
            "orderId": order_id,
        })
        content = self._extract_content(result)
        return self._parse_json(content)

    # ── Response parsing helpers ─────────────────────────────────────────

    @staticmethod
    def _extract_content(result: dict) -> str:
        """Extract text content from MCP response. Raises on empty."""
        content_list = result.get("content", [])
        if not content_list:
            raise RuntimeError("MCP 返回空 content")
        for item in content_list:
            text = item.get("text", "")
            if text:
                return text
        raise RuntimeError("MCP content 中没有 text 字段")

    @staticmethod
    def _parse_json(text: str) -> dict:
        """Parse JSON text. Raises on failure."""
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"MCP 返回非 JSON: {e}") from e

    @staticmethod
    def _parse_json_list(text: str) -> list[dict]:
        """Parse JSON list from text. Raises on failure."""
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"MCP 返回非 JSON: {e}") from e
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("list", "data", "records", "result"):
                if key in data and isinstance(data[key], list):
                    return data[key]
            raise RuntimeError(f"MCP 返回结构不符预期: 期望 list, 得到 {type(data).__name__}")
        raise RuntimeError(f"MCP 返回结构不符预期: 期望 list, 得到 {type(data).__name__}")
