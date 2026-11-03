// yomitoki/index.html から公開無料版 yomitoki/free/index.html を作る。
// 本体を直したら `node yomitoki/tools/build-free.mjs` を実行する（CIで一致を確認している）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "index.html"), "utf8");
const swap = (text, from, to) => {
  if (!text.includes(from)) throw new Error("見つかりません: " + from);
  return text.replace(from, to);
};
let out = src;
out = swap(out, '<script src="./trial-config.js"></script>', '<script src="./free-config.js"></script>');
out = swap(out, "<title>よみとき — AIの言葉を、測り直す。</title>", "<title>よみとき 無料版 — AIの言葉を、測り直す。</title>");
out = swap(out, "<!DOCTYPE html>\n", "<!DOCTYPE html>\n<!-- 自動生成：yomitoki/index.html から yomitoki/tools/build-free.mjs で作成。直接編集しない。 -->\n");
const target = path.join(root, "free", "index.html");
if (process.argv.includes("--check")) {
  const now = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (now !== out) { console.error("free/index.html が本体と揃っていません。build-free.mjs を実行してください。"); process.exit(1); }
  console.log("free/index.html は本体と一致");
} else {
  fs.writeFileSync(target, out);
  console.log("free/index.html を作成");
}
