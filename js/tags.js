/* 解析格莉奇回覆裡的標記。
   純函式、無 DOM 相依，所以測試可以直接用 node --test 跑，不必開瀏覽器。

   語法：
     [sticker:glitch-02]
     [draw:glitch|english prompt|sticker=hole-04@br]
     [emote:happy]

   注意：draw 的 prompt 裡不要放 "|"、"["、"]"。prompt 用 "|" 分隔欄位、
   用 "]" 收尾，"[" 則會被當成標記還沒收尾；prompt 本身含這些字元會被
   解析成多一個欄位、提早收尾或直接收尾失敗，導致整條 draw 因為欄位對
   不上而作廢——這是「整條丟掉、不半生效」的正確結果，不是要修的 bug，
   下 prompt 時避開就好。

   為什麼「合法但欄位不合白名單」與「語法本身就壞掉」都要整條丟掉，而且
   要在整段文字裡找、不能只認「獨佔一行」的標記：
   這些標記是給程式吃的指令，不是給使用者看的文字。標記可能出現在句子
   中間（例如「哈囉 [sticker:glitch-01] 掰掰」），也可能因為換行、漏字被
   切斷。不管哪一種，只要看得出「意圖」是要下指令，就不能讓殘缺的標記
   語法（像裸露的 `[draw:xxx|`）留在使用者看到的畫面上——寧可多吃掉一點
   周圍文字，也不要漏。所以流程分兩段：
     1. 先用「語法完整」的正則抓出合法形狀的標記，逐一判斷欄位是否合白
        名單來決定要不要生效（sticker / draw 的值），但不論生不生效，
        只要抓到就把那段文字整段吃掉——白名單只影響「回傳什麼」，
        不影響「這段文字要不要消失」。
     2. 掃第一段殘留的 `[sticker:` 或 `[draw:` 開頭殘骸（語法本身就不完整
        的），一路吃到最近的 `]` 或字串結尾，整段移除，避免殘骸漏出去。 */

const POS = new Set(["tl", "tr", "bl", "br"]);
const REF = new Set(["glitch", "none"]);

// 不用 ^ / $ 錨定：標記可能出現在一行的中間，也可能和其他文字共用一行。
// prompt 的字元類別刻意排除換行、"|"、"["、"]"（[^|\n[\]]）。換行與 "|"
// 的理由同上；"[" 和 "]" 更關鍵——兩個都要排除，缺一不可：
//   - 只排除 "]"、放行 "["：一條沒寫收尾中括號的標記，只要後面文字裡
//     隨便出現一個不相關的 "["..."]" 片段（例如一般中文語句裡的
//     「[無關內容]」），prompt 就會直接吃穿過那個 "["，借用它自己的
//     "]" 來當收尾，把中間整段本該顯示給使用者的文字吞進 prompt。
//   - 只排除 "["、放行 "]"：prompt 裡如果自己就帶了一組 "[xxx]"
//     （例如 "a [weird] prompt"），會在遇到第一個 "]"（屬於內嵌的那組
//     括號，不是標記真正的收尾）就提早判定收尾，讓語法沒收好的標記被
//     誤判成合法、真的觸發畫圖。
//   兩個都排除之後，prompt 只要一遇到任何 "[" 或 "]" 就無法再往後擴張、
//   也湊不出合法收尾，整條標記在這一關直接匹配失敗，掉進下面的殘骸清掃
//   被整段丟棄——這才是「語法沒收好就整條作廢」該有的行為。
const STICKER_RE = /\[sticker:([a-z]+-\d{2})\]/g;
const EMOTE_RE = /\[emote:([a-z]+)\]/g;
const DRAW_RE = /\[draw:([a-z]+)\|([^|\n[\]]*?)(?:\|sticker=([a-z]+-\d{2})@([a-z]{2}))?\]/g;
// sticker= 之後的 id／pos 用的是固定字元類別（[a-z]、\d），不是排除式的
// 萬用字元類別，不會有同樣「借用不相關 [ / ] 收尾」的問題，不用改。

// 殘骸清掃：抓「看起來像標記開頭，但語法沒收好」的片段。[\s\S] 讓它可以
// 跨行吃到最近的 `]`；如果從頭到尾都沒有 `]`，就吃到字串結尾——寧可多吃
// 字，也不要讓半截標記語法漏出去給使用者看。
const RESIDUE_RE = /\[(?:sticker|draw|emote):[\s\S]*?(?:\]|$)/g;

export function parseTags(text, validStickers, validEmotes) {
  const valid = new Set(validStickers || []);
  const validEmo = new Set(validEmotes || []);
  let sticker = null;
  let draw = null;
  let emote = null;

  let clean = String(text || "");

  clean = clean.replace(STICKER_RE, (_match, id) => {
    // 多個 sticker 標記時取最後一個：replace 依出現順序呼叫 callback，
    // 後面的呼叫覆蓋前面的，天然就是「最後一個生效」。
    if (valid.has(id)) sticker = id;
    return "";
  });

  clean = clean.replace(EMOTE_RE, (_match, id) => {
    // 同 sticker：後面的呼叫覆蓋前面的，最後一個生效；白名單只影響回傳，
    // 不影響「這段文字要不要消失」。
    if (validEmo.has(id)) emote = id;
    return "";
  });

  clean = clean.replace(DRAW_RE, (_match, ref, prompt, tagSticker, pos) => {
    const okRef = REF.has(ref);
    const okPrompt = prompt.trim().length > 0;
    // sticker 欄位是選填的（tagSticker undefined 代表沒寫），但一旦寫了
    // 就要整組（id + 位置）都合法，否則視同欄位壞掉，整條標記作廢。
    const okSticker =
      tagSticker === undefined || (valid.has(tagSticker) && POS.has(pos));
    if (okRef && okPrompt && okSticker) {
      draw = {
        ref,
        prompt: prompt.trim(),
        sticker: tagSticker === undefined ? null : tagSticker,
        pos: pos === undefined ? null : pos,
      };
    }
    return "";
  });

  clean = clean.replace(RESIDUE_RE, "");

  // 行內移除標記會在原位置留下雙空格（例如「哈囉  掰掰」），收乾淨再 trim。
  clean = clean.replace(/ {2,}/g, " ").trim();

  return { clean, sticker, draw, emote };
}
