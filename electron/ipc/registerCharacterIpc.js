const { ipcMain } = require('electron')
const registryService = require('../services/registryService')
const characterImportService = require('../services/characterImportService')

function registerCharacterIpc({ mainWindowRef, settingsWindowRef, loadSettings }) {
  // mainWindowRef + settingsWindowRef are getters because both windows can
  // close + reopen during app lifetime — capturing by value at registration
  // time leaves stale (often null) refs by the time IPC fires. Internal
  // `mainWindow` shorthand below resolves the ref on demand.
  const mainWindow = () => mainWindowRef?.()
  ipcMain.handle('characters:list', async () => {
    registryService.ensureRegistry()
    return {
      ok: true,
      activeCharacterId: registryService.readRegistry().activeCharacterId,
      characters: registryService.listCharacters()
    }
  })

  ipcMain.handle('characters:getActive', async () => {
    registryService.ensureRegistry()
    const registry = registryService.readRegistry()
    return {
      ok: true,
      activeCharacterId: registry.activeCharacterId,
      character: registry.activeCharacterId
        ? registryService.getCharacterById(registry.activeCharacterId)
        : null
    }
  })

  // Step 1: settings UI live sliders → profile.user.json → main window
  // broadcast. registryService writes the file; we forward the new overrides
  // to the main renderer so motionManager applies them without waiting for
  // a character reload.
  ipcMain.handle('characters:setPersonalityOverrides', async (e, payload) => {
    try {
      const { characterId, overrides } = payload || {}
      if (!characterId) throw new Error('characterId required')
      const result = registryService.setCharacterPersonalityOverrides(characterId, overrides)
      const live = mainWindow()
      live?.webContents.send('character-personality-updated', {
        characterId,
        overrides: result.overrides
      })
      return result
    } catch (error) {
      return { ok: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle('characters:getPersonalityOverrides', async (e, { characterId } = {}) => {
    if (!characterId) return { ok: true, overrides: {} }
    return { ok: true, overrides: registryService.getCharacterPersonalityOverrides(characterId) }
  })

  ipcMain.handle('characters:setActive', async (e, { characterId }) => {
    // 서비스가 실제로 throw한다(없는 캐릭터 id). 여기서 안 잡으면 renderer의
    // invoke가 reject되고, 설정 UI는 이미 낙관적으로 바꿔 놓은 상태와 갈라진다.
    let result
    try {
      result = registryService.setActiveCharacter(characterId)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }

    // 활성 캐릭터는 레지스트리가 단일 출처 — settings에 미러하지 않는다.
    // settings-applied는 렌더러가 레지스트리를 다시 읽게 하는 신호로만 쓴다.
    // 입력 id를 그대로 되쏘지 않는다 — 'dummy'는 서비스가 null(내장 캐릭터)로
    // 정규화하므로, 에코하면 브로드캐스트만 레지스트리와 다른 값을 들고 간다.
    const activeId = result.activeCharacterId

    const live = mainWindow()
    live?.webContents.send('settings-applied', loadSettings())
    live?.webContents.send('character-changed', { characterId: activeId })

    const settingsWindow = settingsWindowRef?.()
    settingsWindow?.webContents.send('character-changed', { characterId: activeId })

    return result
  })

  ipcMain.handle('characters:importZip', async (e, payload) => {
    const imported = await characterImportService.importFromZip(payload)

    mainWindow()?.webContents.send('character-imported', imported)

    const settingsWindow = settingsWindowRef?.()
    settingsWindow?.webContents.send('character-imported', imported)

    return imported
  })

  ipcMain.handle('characters:delete', async (e, { characterId }) => {
    // 활성 포인터 재조정은 registryService.deleteCharacter 안에서 끝난다.
    let result
    try {
      result = registryService.deleteCharacter(characterId)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }

    const live = mainWindow()
    live?.webContents.send('settings-applied', loadSettings())
    // 삭제한 게 활성 캐릭터였다면 서비스가 남은 첫 캐릭터로 활성 포인터를 옮긴다.
    // 예전엔 여기서 null을 하드코딩해 보내서, 메인 창은 내장 캐릭터로 폴백하는데
    // 레지스트리는 다른 캐릭터를 활성으로 들고 있는 갈라짐이 났다.
    live?.webContents.send('character-changed', { characterId: result.activeCharacterId })

    return result
  })

  ipcMain.handle('characters:pickZipAndImport', async () => {
    const live = mainWindow()
    const imported = await characterImportService.pickZipAndImport(settingsWindowRef?.() || live)

    if (imported.ok) {
      live?.webContents.send('character-imported', imported)
      const settingsWindow = settingsWindowRef?.()
      settingsWindow?.webContents.send('character-imported', imported)
    }

    return imported
  })

  ipcMain.handle('characters:pickSource', async () => {
    return characterImportService.pickImportSource(settingsWindowRef?.() || mainWindow())
  })
}

module.exports = { registerCharacterIpc }
