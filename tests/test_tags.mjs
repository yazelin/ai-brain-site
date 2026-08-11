import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTags } from "../js/tags.js";

const VALID = [
  "glitch-01", "glitch-02", "glitch-03", "glitch-04", "glitch-05",
  "glitch-06", "glitch-07", "glitch-08", "glitch-09",
  "hole-01", "hole-02", "hole-03", "hole-04", "hole-05",
  "hole-06", "hole-07", "hole-08", "hole-09",
];

test("沒有標記時原文照舊", () => {
  const r = parseTags("逼——嗶！你好呀。", VALID);
  assert.equal(r.clean, "逼——嗶！你好呀。");
  assert.equal(r.sticker, null);
  assert.equal(r.draw, null);
});

test("解析貼圖標記並從文字中移除", () => {
  const r = parseTags("今天超開心！\n[sticker:glitch-02]", VALID);
  assert.equal(r.clean, "今天超開心！");
  assert.equal(r.sticker, "glitch-02");
});

test("兩組貼圖前綴都吃得到", () => {
  const r = parseTags("[sticker:hole-06]", VALID);
  assert.equal(r.sticker, "hole-06");
  assert.equal(r.clean, "");
});

test("解析畫圖標記，不含貼圖", () => {
  const r = parseTags("我畫給你看！\n[draw:glitch|a robot girl in a neon room]", VALID);
  assert.equal(r.clean, "我畫給你看！");
  assert.deepEqual(r.draw, {
    ref: "glitch",
    prompt: "a robot girl in a neon room",
    sticker: null,
    pos: null,
  });
});

test("解析畫圖標記，含貼圖與位置", () => {
  const r = parseTags("[draw:none|an empty office at night|sticker=hole-04@br]", VALID);
  assert.deepEqual(r.draw, {
    ref: "none",
    prompt: "an empty office at night",
    sticker: "hole-04",
    pos: "br",
  });
});

test("貼圖與畫圖可以同時出現", () => {
  const r = parseTags("好喔\n[sticker:glitch-03]\n[draw:glitch|waving hello]", VALID);
  assert.equal(r.sticker, "glitch-03");
  assert.equal(r.draw.prompt, "waving hello");
  assert.equal(r.clean, "好喔");
});

test("編號不存在的貼圖整條丟掉", () => {
  const r = parseTags("嗨\n[sticker:glitch-99]", VALID);
  assert.equal(r.sticker, null);
  assert.equal(r.clean, "嗨");
});

test("不認識的 set 整條丟掉", () => {
  const r = parseTags("[sticker:cat-01]", VALID);
  assert.equal(r.sticker, null);
  assert.equal(r.clean, "");
});

test("ref 不在白名單時整條畫圖標記丟掉", () => {
  const r = parseTags("嗨\n[draw:banana|something]", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.clean, "嗨");
});

test("pos 不在白名單時整條畫圖標記丟掉", () => {
  const r = parseTags("[draw:glitch|x|sticker=hole-01@zz]", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.clean, "");
});

test("prompt 是空的時整條畫圖標記丟掉", () => {
  const r = parseTags("[draw:glitch|]", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.clean, "");
});

test("語法壞掉的標記不會漏到畫面上", () => {
  const r = parseTags("嗨\n[draw:xxx|\n[sticker:]", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.sticker, null);
  assert.equal(r.clean, "嗨");
});

test("多個貼圖標記時取最後一個", () => {
  const r = parseTags("[sticker:glitch-01]\n[sticker:hole-09]", VALID);
  assert.equal(r.sticker, "hole-09");
  assert.equal(r.clean, "");
});

test("空輸入不會爆", () => {
  const r = parseTags("", VALID);
  assert.equal(r.clean, "");
  assert.equal(r.sticker, null);
  assert.equal(r.draw, null);
});

test("標記沒有獨佔一行時也要吃掉，不能漏給使用者看", () => {
  const r = parseTags("哈囉 [sticker:glitch-01] 掰掰", VALID);
  assert.equal(r.sticker, "glitch-01");
  assert.ok(!r.clean.includes("["), `clean 不該含標記語法: ${r.clean}`);
});

test("行內的畫圖標記一樣要吃掉", () => {
  const r = parseTags("好啊 [draw:glitch|a robot waving] 等我一下", VALID);
  assert.equal(r.draw.prompt, "a robot waving");
  assert.ok(!r.clean.includes("["), `clean 不該含標記語法: ${r.clean}`);
});

test("被換行切斷的標記不留殘骸", () => {
  const r = parseTags("嗨\n[draw:glitch|line1\nline2]", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.clean, "嗨");
});

test("沒有結尾中括號的標記也要吃掉", () => {
  const r = parseTags("嗨\n[draw:glitch|沒有收尾", VALID);
  assert.equal(r.draw, null);
  assert.equal(r.clean, "嗨");
});

test("任何情況下 clean 都不會殘留標記語法", () => {
  const inputs = [
    "[sticker:glitch-01]",
    "文字 [sticker:hole-09] 文字",
    "[draw:glitch|x]",
    "[draw:banana|x]",
    "[draw:glitch|x|sticker=hole-01@zz]",
    "[sticker:",
    "[draw:",
    "前面 [draw:glitch|多行\n中間\n後面]",
  ];
  for (const s of inputs) {
    const r = parseTags(s, VALID);
    assert.ok(!/\[(sticker|draw):/.test(r.clean), `殘留標記: ${JSON.stringify(r.clean)} ← ${JSON.stringify(s)}`);
  }
});

test("未閉合的畫圖標記不會借用後面無關的中括號當結尾", () => {
  const r = parseTags("開頭 [draw:glitch|沒收尾 中間正常句子 [無關內容] 結束", VALID);
  assert.equal(r.draw, null, "語法不完整的 draw 必須整條作廢,不能誤判成合法");
  assert.ok(!/\[(sticker|draw):/.test(r.clean), `殘留標記: ${JSON.stringify(r.clean)}`);
});

test("prompt 裡含中括號的畫圖標記整條作廢", () => {
  assert.equal(parseTags("[draw:glitch|a [weird] prompt]", VALID).draw, null);
});
