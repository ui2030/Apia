const { ipcMain } = require('electron')
const registryService = require('../services/registryService')
const characterImportService = require('../services/characterImportService')

function registerCharacterIpc({ mainWindowRef, settingsWindowRef, loadSettings, saveSettings }) {
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
    const result = registryService.setActiveCharacter(characterId)

    const settings = loadSettings()
    settings.activeCharacter = characterId
    settings.activeModel = characterId
    saveSettings(settings)

    const live = mainWindow()
    live?.webContents.send('settings-applied', settings)
    live?.webContents.send('character-changed', { characterId })

    const settingsWindow = settingsWindowRef?.()
    settingsWindow?.webContents.send('character-changed', { characterId })

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
    const result = registryService.deleteCharacter(characterId)

    // active가 바뀌었을 수 있으므로 settings 동기화
    const settings = loadSettings()
    if (settings.activeCharacter === characterId) {
      const registry = registryService.readRegistry()
      settings.activeCharacter = registry.activeCharacterId || 'dummy'
      settings.activeModel = settings.activeCharacter
      saveSettings(settings)
    }

    const live = mainWindow()
    live?.webContents.send('settings-applied', loadSettings())
    live?.webContents.send('character-changed', { characterId: null })

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
