"""
Fibonacci 算法实现
- fib_recursive: 递归 + lru_cache 记忆化
- fib_iterative: 迭代，O(1) 空间
"""

import functools


# ── Part 1: 递归实现 ──────────────────────────────────────────────────────────

@functools.lru_cache(maxsize=None)
def fib_recursive(n: int) -> int:
    """递归实现，使用 lru_cache 避免重复计算。"""
    if n < 0:
        raise ValueError(f"n 必须为非负整数，got {n}")
    if n == 0:
        return 0
    if n == 1:
        return 1
    return fib_recursive(n - 1) + fib_recursive(n - 2)


# ── Part 2: 迭代实现 ──────────────────────────────────────────────────────────

def fib_iterative(n: int) -> int:
    """迭代实现，空间复杂度 O(1)。"""
    if n < 0:
        raise ValueError(f"n 必须为非负整数，got {n}")
    if n == 0:
        return 0
    a, b = 0, 1
    for _ in range(1, n):
        a, b = b, a + b
    return b


# ── Part 3: 测试用例 + 主入口 ─────────────────────────────────────────────────

def run_tests():
    cases = [
        (0, 0),
        (1, 1),
        (2, 1),
        (10, 55),
        (20, 6765),
    ]

    for impl_name, impl in [("fib_recursive", fib_recursive),
                             ("fib_iterative", fib_iterative)]:
        print(f"\n── {impl_name} ──")

        # 正常用例
        for n, expected in cases:
            result = impl(n)
            status = "PASS" if result == expected else f"FAIL (got {result})"
            print(f"  fib({n:>2}) = {result:>5}  [{status}]")

        # 负数边界
        try:
            impl(-1)
            print("  fib(-1)        [FAIL — 应抛出 ValueError]")
        except ValueError:
            print("  fib(-1)        [PASS — 正确抛出 ValueError]")


if __name__ == "__main__":
    run_tests()

    print("\n── 前 15 个 Fibonacci 数（迭代）──")
    print([fib_iterative(i) for i in range(15)])
