/* 桌寵的活體版本：把 glitch-2d 的原生 2D 骨架掛進 #pet 的 canvas。
   來源 repo https://github.com/yazelin/glitch-2d ，engine/ 與 rig.json 是抄過來的
   副本（照慣例把相依打包進 repo，離線才不會缺件）。更新方式寫在 README。

   emote 的定義住在 glitch-2d 的 engine/motion.js，跟著 sync_glitch2d.py 一起抄
   過來，這邊不再留一份，免得改一邊忘記另一邊。

   對外只有 mountPet()。它回傳的 handle 就是站上會用到的四件事：
   表情、揮手、跟著音訊動嘴、把自己收掉。載入失敗時回傳 null，
   呼叫端保持原本的靜態圖，不會開天窗。 */
import { Motion, EMOTES, GLITCHED_EMOTES, EMOTE_EYES, NEUTRAL_POSE } from './engine/motion.js';
import { buildScene } from './engine/geometry.js';
import { WebGLRenderer, CanvasRenderer, loadTextures } from './engine/renderer.js';
import { VoicePlayer } from './engine/audio.js';

export async function mountPet(canvas, options = {}) {
  const { view = 'full', base = new URL('./', import.meta.url), onError } = options;
  let rig, textures;
  try {
    const rigURL = new URL('rig.json', base);
    const response = await fetch(rigURL, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`rig ${response.status}`);
    rig = await response.json();
    textures = await loadTextures(rig, rigURL);
  } catch (error) {
    onError?.(error);
    return null;
  }

  let surface = canvas, renderer;
  try {
    renderer = new WebGLRenderer(surface, textures);
  } catch {
    // 失敗的 WebGL context 會把 canvas 的 context 型別鎖住，換一個新節點再試 2D。
    const replacement = surface.cloneNode();
    surface.replaceWith(replacement); surface = replacement;
    try { renderer = new CanvasRenderer(surface, textures); }
    catch (error) { onError?.(error); return null; }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = new Motion();
  motion.idle = !reduced.matches;
  motion.follow = false;                       // 桌寵不吃滑鼠，游標在整個桌面上跑
  // 播放狀態往外送，呼叫端才知道音檔播完了要把按鈕收回去。
  const voice = new VoicePlayer(motion, state => handle.onvoice?.(state));
  let framing = Object.hasOwn(rig.views, view) ? view : 'full';
  let emoteTimer = 0, glitching = false, visible = true, awake = !document.hidden, frameID = 0;

  const resize = () => {
    const box = surface.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, renderer.kind === 'WebGL' ? 2 : 1.5);
    const width = Math.max(1, Math.round((box.width || surface.clientWidth) * dpr));
    const height = Math.max(1, Math.round((box.height || surface.clientHeight) * dpr));
    if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(surface);
  // 捲出畫面或分頁切走就停 rAF：桌寵常駐，不能一直吃 GPU。
  const seen = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }, { threshold: 0 });
  seen.observe(surface);
  const onVisibility = () => { awake = !document.hidden; };
  document.addEventListener('visibilitychange', onVisibility);

  // 桌寵是常駐的，不需要 60fps。累積到 32fps 才畫一次，GPU 與電池省一半，
  // 動作是指數平滑的，dt 大一點不會跳。
  const FRAME = 1 / 32;
  let previous = performance.now(), pending = 0;
  const frame = now => {
    const dt = Math.min((now - previous) / 1000, .05); previous = now;
    pending += dt;
    if (visible && awake && pending >= FRAME) {
      const step = pending; pending = 0;
      voice.update();
      const pose = motion.step(step);
      if (glitching) {
        // 當機用抖動表現，不動素材：眼睛半閉加上每幀亂跳的頭部位移。
        pose.headX = (Math.random() - .5) * 1.4;
        pose.headZ = (Math.random() - .5) * 1.2;
      }
      const options = { framing };
      renderer.render(buildScene(rig, pose, options), rig, options);
    } else if (!visible || !awake) pending = 0;
    frameID = requestAnimationFrame(frame);
  };
  frameID = requestAnimationFrame(frame);

  const neutral = () => {
    glitching = false;
    motion.setParameters(NEUTRAL_POSE);
    motion.setSlots({ eyes: 'default' });
    handle.onemote?.(null);
  };

  const handle = {
    canvas: surface,
    onvoice: null,
    onemote: null,
    renderer: renderer.kind,
    /* 站上的 [emote:xxx] 走這裡。hold 到了就自己回到平常的臉。 */
    emote(id, hold = 6000) {
      clearTimeout(emoteTimer);
      const preset = id && Object.hasOwn(EMOTES, id) && EMOTES[id];
      if (!preset) { neutral(); return false; }
      glitching = GLITCHED_EMOTES.includes(id);
      // 先回到平常臉再疊，表情之間切換才不會把上一個的殘留帶過去。
      motion.setParameters({ ...NEUTRAL_POSE, ...preset });
      // happy and error swap in drawn eyes; the rest use the base art.
      motion.setSlots({ eyes: EMOTE_EYES[id] ?? 'default' });
      emoteTimer = setTimeout(neutral, hold);
      handle.onemote?.(id);
      return true;
    },
    wave() { motion.wave(); motion.blink(); },
    blink() { motion.blink(); },
    setView(name) { if (Object.hasOwn(rig.views, name)) framing = name; },
    /* 講話時嘴型跟著音量走。VoicePlayer 自己有一個 <audio>，
       所以站上要帶嘴型的音檔改成從這裡播，不要另外 new Audio()。 */
    speak(url) { return voice.play(url); },
    get speaking() { return motion.speaking; },
    /* 驗收用：揮手期間為 true。連點時用它確認第二次被忽略——重揮的話這段
       時間會從一次揮手的長度變成「點下去到最後一次點擊再加一次揮手」。 */
    get waving() { return motion.waving; },
    /* 驗收用：講話時這個值應該跟著音量跳動，靜止時是 0。 */
    get mouthOpen() { return motion.values.mouthOpen; },
    stopSpeaking() { voice.stop(); },
    dispose() {
      cancelAnimationFrame(frameID); clearTimeout(emoteTimer);
      observer.disconnect(); seen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      voice.dispose(); renderer.dispose();
    },
  };
  return handle;
}
