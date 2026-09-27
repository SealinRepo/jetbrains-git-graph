/**
 * hunk 内容指纹：用来在文件被编辑后**重新定位**一个已登记的 hunk，而不是
 * 让它因为行号漂移而失效。
 *
 * 只取 hunk 里真正变动的那些行（`+` / `-`），去掉行号、去掉上下文。所以：
 * - 在文件上方插入/删除行 → 指纹不变 → 分配自动跟着新行号走（关键场景：
 *   把改动移进某个列表之后，又在文件别处继续改代码）
 * - 改动本身被编辑过 → 指纹变了 → 分配失效，hunk 回到活动列表，与
 *   IDEA 的处理一致
 *
 * 必须是纯函数、不能用 node 内置 crypto —— webview 侧（浏览器环境）也要用
 * 同一份实现。这里用 FNV-1a 32 位哈希，稳定且足够。
 */
export function hunkFingerprint(patchText: string): string {
  const changed: string[] = [];
  for (const raw of patchText.split("\n")) {
    // 跳过 hunk 头（@@ ... @@）——它带着会漂移的行号
    if (raw.startsWith("@@")) continue;
    // 文件头标记（+++ / ---）不是 hunk 内容
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) {
      changed.push(raw.slice(1));
    }
  }
  return fnv1a(changed.join("\n"));
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32 位 FNV 质数乘法的等价写法，避免超出安全整数范围
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
