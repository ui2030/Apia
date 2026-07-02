// 핫코너 창 전용 preload. 메인 preload와 분리해 표면적을 최소화한다 — 설정/채팅
// 열기와 reveal 구독만 노출한다(입력창·민감 IPC 없음). reveal 신호는 메인
// 프로세스의 커서 폴링이 보낸다(corner:reveal).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cornerApi', {
  openSettings: () => ipcRenderer.invoke('open-settings'),
  chatToggle: () => ipcRenderer.invoke('chat:toggle'),
  onReveal: (cb) => ipcRenderer.on('corner:reveal', (_e, on) => cb(on))
})
