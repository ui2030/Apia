const { ipcMain } = require('electron')
const registryService = require('../services/registryService')
const characterImportService = require('../services/characterImportService')

function registerCharacterIpc({ mainWindow, settingsWindowRef, loadSettings, saveSettings }) {
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

  ipcMain.handle('characters:setActive', async (e, { characterId }) => {
    const result = registryService.setActiveCharacter(characterId)

    const settings = loadSettings()
    settings.activeCharacter = characterId
    saveSettings(settings)

    mainWindow?.webContents.send('settings-applied', settings)
    mainWindow?.webContents.send('character-changed', { characterId })

    const settingsWindow = settingsWindowRef?.()
    settingsWindow?.webContents.send('character-changed', { characterId })

    return result
  })

  ipcMain.handle('characters:importZip', async (e, payload) => {
    const imported = await characterImportService.importFromZip(payload)

    mainWindow?.webContents.send('character-imported', imported)

    const settingsWindow = settingsWindowRef?.()
    settingsWindow?.webContents.send('character-imported', imported)

    return imported
  })

  ipcMain.handle('characters:pickZipAndImport', async () => {
    const imported = await characterImportService.pickZipAndImport(settingsWindowRef?.() || mainWindow)

    if (imported.ok) {
      mainWindow?.webContents.send('character-imported', imported)
      const settingsWindow = settingsWindowRef?.()
      settingsWindow?.webContents.send('character-imported', imported)
    }

    return imported
  })
}

module.exports = { registerCharacterIpc }
