# 🌐 格莉奇分散式社群算力網格架構 (Glitch Distributed Node Mesh)

本文檔記錄 [ai-brain-site (格莉奇OS)](https://yazelin.github.io/ai-brain-site/) 與後端分散式開源算力節點（如 [glitch-server](https://github.com/yazelin/glitch-server)）的協同架構與通訊規範。

---

## 1. 系統架構圖 (Architecture Overview)

```
┌────────────────────────────────────────────────────────┐
│               前端客戶端 (ai-brain-site)               │
│   • 🎙️ 語音通話 (全雙工 Barge-In)                      │
│   • 🧠 LLM 大腦推理                                    │
│   • ⚙️ 社群節點動態選擇器 (Voice / LLM / Video / ...)   │
└───────────────────────┬────────────────────────────────┘
                        │
                        ▼ (自動查詢在線節點 GET /voice/nodes)
┌────────────────────────────────────────────────────────┐
│     Cloudflare Worker + KV (GLITCH_VOICE_NODES)        │
│   • 節點心跳與註冊中心 (TTL: 300s 自動過期清理)         │
│   • 網址: https://glitch-chat.yazelinj303.workers.dev  │
└───────────────────────▲────────────────────────────────┘
                        │
                        │ 心跳回報 (POST /voice/register)
┌───────────────────────┴────────────────────────────────┐
│          分散式社群算力節點 (glitch-server)             │
│   • 本機節點 (RTX 4060) / 開源社群自建節點              │
│   • Cloudflare Quick Tunnel (自動 HTTPS 穿透)          │
│   • 雙核心 TTS (F5-TTS Base 337M + CosyVoice 3 0.5B)    │
│   • 雙軌台灣化音準替身系統 (taiwanize.py)               │
│   • 專業錄音室廣播控制台 (@ http://127.0.0.1:8000)      │
└────────────────────────────────────────────────────────┘
```

---

## 2. 服務能力分類 (Service Capabilities)

未來社群節點可承載與註冊以下五大 AI 服務：

| 服務標籤 (`service`) | 核心職責 | 核心技術棧 | 輸出格式 |
| :--- | :--- | :--- | :--- |
| **`voice`** | 語音合成、聲紋克隆、情感發音 | F5-TTS Base (337M)、CosyVoice 3 (0.5B) | 24kHz PCM WAV / Base64 |
| **`llm`** | 角色對話、小說人設、世界觀記憶 | Ollama、vLLM、Llama.cpp、DeepSeek | OpenAI SSE Chat Stream |
| **`reaction`** | 直播彈幕即時反應、情緒表情判定、動作觸發 | Fast-Brain (Qwen-1.5B/4B) | Emotion / Action JSON |
| **`video`** | Live2D 動態立繪、實時口型同步、視訊流 | Live2D WebGL、LivePortrait、MuseTalk | WebRTC / 骨骼座標 |
| **`vision`** | 生草圖、角色插畫生成、周邊立繪 | ComfyUI、SDXL、Flux | PNG / WebP URL |

---

## 3. Cloudflare KV 註冊中心通訊協議

* **端點**：`https://glitch-chat.yazelinj303.workers.dev`
* **KV Namespace**：`GLITCH_VOICE_NODES` (`id = "fd26c85ec13745ef94e985fac027a955"`)

### 註冊節點 (`POST /voice/register`)
```json
{
  "id": "node-yaze-4060",
  "name": "林亞澤的 RTX 4060 節點 (台北)",
  "url": "https://xxxx.trycloudflare.com",
  "engine": "F5-TTS Base 337M / CosyVoice 3 0.5B",
  "character": "格莉奇 (Glitch)",
  "version": "1.1",
  "is_default": true
}
```

### 查詢在線節點 (`GET /voice/nodes`)
```json
{
  "nodes": [
    {
      "id": "node-yaze-4060",
      "name": "林亞澤的 RTX 4060 節點 (台北)",
      "url": "https://xxxx.trycloudflare.com",
      "is_default": true,
      "last_seen": 1787814128000
    }
  ]
}
```

---

## 4. 前端自動發現與參數注入機制

1. **URL 參數自動套用**：
   * 訪問 `https://yazelin.github.io/ai-brain-site/?set_server=https://xxxx.trycloudflare.com` 時，前端會自動寫入 `localStorage.getItem("glitch_custom_server")`，無需手動複製貼上。
2. **設定視窗動態下拉選單**：
   * 前端開啟「設定」視窗時，會自動向 KV 中心抓取所有在線節點並列於選單，包含 `💻 本機端點 (http://127.0.0.1:8000)` 與所有在線社群節點。
