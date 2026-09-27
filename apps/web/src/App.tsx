/**
 * 数字人页面外壳：两个模式页签
 *   朗读：文本/按住说话 → 合成语音 → 播放（SpeakPanel）
 *   聊天：会话制实时对话，按住说话/打字 → ASR → LLM → TTS → 播放（ChatPanel）
 */
import { useState } from 'react';
import SpeakPanel from './SpeakPanel';
import ChatPanel from './ChatPanel';
import './App.css';

type Mode = 'speak' | 'chat';

export default function App() {
  const [mode, setMode] = useState<Mode>('chat');

  return (
    <main className="page">
      <h1>数字人 Demo</h1>
      <p className="subtitle">让数字人开口朗读，或与它实时聊天（听 → 想 → 说）</p>

      <div className="tabs">
        <button className={`tab-btn${mode === 'chat' ? ' on' : ''}`} onClick={() => setMode('chat')}>
          💬 实时聊天
        </button>
        <button className={`tab-btn${mode === 'speak' ? ' on' : ''}`} onClick={() => setMode('speak')}>
          🔊 朗读模式
        </button>
      </div>

      {mode === 'chat' ? <ChatPanel /> : <SpeakPanel />}
    </main>
  );
}
