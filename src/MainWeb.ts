/*
 * Copyright 2014-2016 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import path = require('path');
import electron = require('electron');
const Menu = electron.remote.Menu;
const MenuItem = electron.remote.MenuItem;

import sourceMapSupport = require('source-map-support');
import _ = require('lodash');
import he = require('he');
import Logger from './Logger';
import * as Messages from './WindowMessages';
import * as WebIpc from './WebIpc';
import CbContextMenu = require('./gui/contextmenu');
import CbMenuItem = require('./gui/menuitem');
import CbDropDown = require('./gui/dropdown');
import CbCheckBoxMenuItem = require('./gui/checkboxmenuitem');
import PopDownListPicker = require('./gui/PopDownListPicker');
import ResizeRefreshElementBase = require('./ResizeRefreshElementBase');
import CommandPaletteTypes = require('./gui/commandpalettetypes');
import * as CommandPaletteRequestTypes from './CommandPaletteRequestTypes';

import PluginApi = require('./PluginApi');
import PluginManager = require('./PluginManager');
import InternalExtratermApi = require('./InternalExtratermApi');

import MainWebUi from './MainWebUi';
import EtTerminal from './Terminal';
import * as DomUtils from './DomUtils';
import util = require('./gui/util');

import EtEmbeddedViewer from './EmbeddedViewer';
import AboutTab = require('./abouttab');
import SettingsTab = require('./settings/settingstab2');
import EtTerminalViewer = require('./viewers/terminalviewer');
import EtTextViewer = require('./viewers/textviewer');
import ResizeCanary from './ResizeCanary';

import * as config from './Config';
type Config = config.Config;
type ConfigManager = config.ConfigManager;
type SessionProfile = config.SessionProfile;

import * as ThemeTypes from './Theme';
import * as ThemeConsumer from './ThemeConsumer';
type ThemeInfo = ThemeTypes.ThemeInfo;

import * as keybindingmanager from './KeyBindingManager';
type KeyBindingManager = keybindingmanager.KeyBindingManager;
type KeyBindingContexts = keybindingmanager.KeyBindingContexts;

sourceMapSupport.install();

const PLUGINS_DIRECTORY = "plugins";

const PALETTE_GROUP = "mainweb";
const MENU_ITEM_SPLIT = 'split';
const MENU_ITEM_SETTINGS = 'settings';
const MENU_ITEM_KEY_BINDINGS = 'key_bindings';
const MENU_ITEM_DEVELOPER_TOOLS = 'developer_tools';
const MENU_ITEM_ABOUT = 'about';
const MENU_ITEM_RELOAD_CSS = 'reload_css';
const ID_COMMAND_PALETTE = "ID_COMMAND_PALETTE";
const ID_MENU_BUTTON = "ID_MENU_BUTTON";

const CLASS_RESULT_GROUP_HEAD = "CLASS_RESULT_GROUP_HEAD";
const CLASS_RESULT_ICON_LEFT = "CLASS_RESULT_ICON_LEFT";
const CLASS_RESULT_ICON_RIGHT = "CLASS_RESULT_ICON_RIGHT";
const CLASS_RESULT_LABEL = "CLASS_RESULT_LABEL";
const CLASS_RESULT_SHORTCUT = "CLASS_RESULT_SHORTCUT";

const _log = new Logger("mainweb");

/**
 * This module has control of the window and is responsible for
 * starting up the main component and handling the window directly.
 */

let terminalIdCounter = 0;
let keyBindingManager: KeyBindingManager = null;
let themes: ThemeInfo[];
let mainWebUi: MainWebUi = null;
let configManager: ConfigManagerImpl = null;
let pluginManager: PluginManager.PluginManager = null;
let internalExtratermApi: InternalExtratermApiImpl = null;

/**
 * 
 */
export function startUp(): void {
  if (process.platform === "darwin") {
    setupOSXEmptyMenus();
  }

  // Theme control for the window level.
  const topThemeable: ThemeTypes.Themeable = {
    setThemeCssMap(cssMap: Map<ThemeTypes.CssFile, string>): void {      
      (<HTMLStyleElement> document.getElementById('THEME_STYLE')).textContent =
        cssMap.get(ThemeTypes.CssFile.GUI_CONTROLS) + "\n" + 
        cssMap.get(ThemeTypes.CssFile.FONT_AWESOME) + "\n" + 
        cssMap.get(ThemeTypes.CssFile.TOP_WINDOW) + "\n" +
        cssMap.get(ThemeTypes.CssFile.TERMINAL_VARS);
    }
  };
  ThemeConsumer.registerThemeable(topThemeable);

  WebIpc.start();
  
  const doc = window.document;
  
  // Default handling for config messages.
  WebIpc.registerDefaultHandler(Messages.MessageType.CONFIG, handleConfigMessage);
  
  // Default handling for theme messages.
  WebIpc.registerDefaultHandler(Messages.MessageType.THEME_LIST, handleThemeListMessage);
  WebIpc.registerDefaultHandler(Messages.MessageType.THEME_CONTENTS, handleThemeContentsMessage);
  
  WebIpc.registerDefaultHandler(Messages.MessageType.DEV_TOOLS_STATUS, handleDevToolsStatus);
  
  WebIpc.registerDefaultHandler(Messages.MessageType.CLIPBOARD_READ, handleClipboardRead);
  
  // Get the Config working.
  configManager = new ConfigManagerImpl();
  keyBindingManager = new KeyBindingManagerImpl();  // depends on the config.
  const themePromise = WebIpc.requestConfig().then( (msg: Messages.ConfigMessage) => {
    return handleConfigMessage(msg);
  });
  
  // Get the config and theme info in and then continue starting up.
  const allPromise = Promise.all<void>( [themePromise, WebIpc.requestThemeList().then(handleThemeListMessage)] );
  allPromise.then( (): Promise<FontFace[]> => {
    // Next phase is wait for the fonts to load.
    const fontPromises: Promise<FontFace>[] = [];
    window.document.fonts.forEach( (font: FontFace) => {
      if (font.status !== 'loaded' && font.status !== 'loading') {
        fontPromises.push(font.load());
      }
    });
    return Promise.all<FontFace>( fontPromises );
  }).then( () => {
    // Fonts are loaded, continue.
    CbContextMenu.init();
    CbMenuItem.init();
    CbDropDown.init();
    MainWebUi.init();
    CbCheckBoxMenuItem.init();
    PopDownListPicker.init();
    ResizeCanary.init();

    window.addEventListener('resize', () => {
      if (mainWebUi !== null) {
        mainWebUi.refresh(ResizeRefreshElementBase.RefreshLevel.RESIZE);
      }
    });

    // Get the plugins loaded.
    pluginManager = new PluginManager.PluginManager(path.join(__dirname, PLUGINS_DIRECTORY));
    internalExtratermApi = new InternalExtratermApiImpl();
    pluginManager.load(internalExtratermApi);

    mainWebUi = <MainWebUi>doc.createElement(MainWebUi.TAG_NAME);
    mainWebUi.setInternalExtratermApi(internalExtratermApi);
    config.injectConfigManager(mainWebUi, configManager);
    keybindingmanager.injectKeyBindingManager(mainWebUi, keyBindingManager);
    mainWebUi.innerHTML = `<div class="tab_bar_rest">
      <div class="space"></div>
      <cb-dropdown>
          <button id="${ID_MENU_BUTTON}" class="btn btn-quiet"><i class="fa fa-bars"></i></button>
          <cb-contextmenu id="main_menu">
              <cb-checkboxmenuitem icon="columns" id="${MENU_ITEM_SPLIT}" name="split">Split</cb-checkboxmenuitem>
              <cb-menuitem icon="wrench" name="${MENU_ITEM_SETTINGS}">Settings</cb-menuitem>
              <cb-menuitem icon="keyboard-o" name="${MENU_ITEM_KEY_BINDINGS}">Key Bindings</cb-menuitem>
              <cb-checkboxmenuitem icon="cogs" id="${MENU_ITEM_DEVELOPER_TOOLS}" name="developer_tools">Developer Tools</cb-checkboxmenuitem>
              <cb-menuitem icon="lightbulb-o" name="${MENU_ITEM_ABOUT}">About</cb-menuitem>
          </cb-contextmenu>
      </cb-dropdown>
    </div>`;

    mainWebUi.themes = themes;
      
    doc.body.classList.remove("preparing");
    doc.body.innerHTML = "";  // Remove the old contents.
    
    doc.body.appendChild(mainWebUi);
    
    // A special element for tracking when terminal fonts are effectively changed in the DOM.
    const resizeCanary = <ResizeCanary> doc.createElement(ResizeCanary.TAG_NAME);
    resizeCanary.setCss(`
    font-family: var(--terminal-font);
    font-size: var(--default-terminal-font-size);
`);
    doc.body.appendChild(resizeCanary);
    resizeCanary.addEventListener('resize', () => {
      mainWebUi.refresh(ResizeRefreshElementBase.RefreshLevel.COMPLETE);
    });
    
    setUpCommandPalette();

    // Make sure something sensible is focussed if the window gets the focus.
    window.addEventListener('focus', () => {
      mainWebUi.focus();
    });
    
    if (process.platform === "darwin") {
      setupOSXMenus(mainWebUi);
    }
    
    // Detect when the last tab has closed.
    mainWebUi.addEventListener(MainWebUi.EVENT_TAB_CLOSED, (ev: CustomEvent) => {
      if (mainWebUi.tabCount === 0) {
        WebIpc.windowCloseRequest();
      }
    });
    
    // Update the window title on request.
    mainWebUi.addEventListener(MainWebUi.EVENT_TITLE, (ev: CustomEvent) => {
      window.document.title = "Extraterm - " + ev.detail.title;
    });

    mainWebUi.addEventListener(MainWebUi.EVENT_SPLIT, () => {
      const splitMenu = <CbCheckBoxMenuItem> document.getElementById("split");
      splitMenu.checked = mainWebUi.split;
    });

    mainWebUi.addEventListener(MainWebUi.EVENT_MINIMIZE_WINDOW_REQUEST, () => {
      WebIpc.windowMinimizeRequest();
    });

    mainWebUi.addEventListener(MainWebUi.EVENT_MAXIMIZE_WINDOW_REQUEST, () => {
      WebIpc.windowMaximizeRequest();
    });

    mainWebUi.addEventListener(MainWebUi.EVENT_CLOSE_WINDOW_REQUEST, () => {
      WebIpc.windowCloseRequest();
    });

    const mainMenu = doc.getElementById('main_menu');
    mainMenu.addEventListener('selected', (ev: CustomEvent) => {
      executeMenuCommand(ev.detail.name);
    });
    
    mainWebUi.addEventListener(CommandPaletteRequestTypes.EVENT_COMMAND_PALETTE_REQUEST, (ev: CustomEvent) => {
        handleCommandPaletteRequest(ev.detail);
      });
      
    doc.addEventListener('mousedown', (ev: MouseEvent) => {
      if (ev.which === 2) {
        WebIpc.clipboardReadRequest();
        
        // This is needed to stop the autoscroll blob from appearing on Windows.
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    
    mainWebUi.newTerminalTab(MainWebUi.POSITION_LEFT);
    mainWebUi.focus();
    window.focus();
  });
}


function executeMenuCommand(command: string): boolean {
  if (command === MENU_ITEM_DEVELOPER_TOOLS) {
    // Unflip what the user did to the state of the developer tools check box for a moment.
    // Let executeCommand() toggle the checkbox itself. 
    const developerToolMenu = <CbCheckBoxMenuItem> document.getElementById("developer_tools");
    const devToolsOpen = util.toBoolean(developerToolMenu.getAttribute(CbCheckBoxMenuItem.ATTR_CHECKED));
    developerToolMenu.setAttribute(CbCheckBoxMenuItem.ATTR_CHECKED, "" + ( ! devToolsOpen) );
  }

  return executeCommand(command);
}

function executeCommand(command: string): boolean {
  switch(command) {
    case MENU_ITEM_SPLIT:
      const splitMenu = <CbCheckBoxMenuItem> document.getElementById("split");
      mainWebUi.split = util.toBoolean(splitMenu.getAttribute(CbCheckBoxMenuItem.ATTR_CHECKED));
      break;
      
    case MENU_ITEM_SETTINGS:
      mainWebUi.openSettingsTab();
      break;
      
    case MENU_ITEM_KEY_BINDINGS:
      mainWebUi.openKeyBindingsTab();
      break;
      
    case MENU_ITEM_DEVELOPER_TOOLS:
      const developerToolMenu = <CbCheckBoxMenuItem> document.getElementById("developer_tools");
      const devToolsOpen = util.toBoolean(developerToolMenu.getAttribute(CbCheckBoxMenuItem.ATTR_CHECKED));
      developerToolMenu.setAttribute(CbCheckBoxMenuItem.ATTR_CHECKED, "" + ( ! devToolsOpen) );
      WebIpc.devToolsRequest( ! devToolsOpen);
      break;

    case MENU_ITEM_ABOUT:
      mainWebUi.openAboutTab();
      break;
      
    case MENU_ITEM_RELOAD_CSS:
      reloadThemeContents();
      break;

    default:
      return false;
  }
  return true;  
}

function setupOSXEmptyMenus(): void {
  const template: Electron.MenuItemOptions[] = [{
    label: "Extraterm",
  }];
  
  const emptyTopMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(emptyTopMenu);  
}

function setupOSXMenus(mainWebUi: MainWebUi): void {
  const template: Electron.MenuItemOptions[] = [{
    label: "Extraterm",
    submenu: [
      {
        label: 'About Extraterm',
        click(item, focusedWindow) {
          mainWebUi.openAboutTab();
        },
      },
      {
        type: 'separator'
      },
      {
        label: 'Preferences...',
        click(item, focusedWindow) {
          mainWebUi.openSettingsTab();
        },
      },
      {
        label: 'Key Bindings...',
        click(item, focusedWindow) {
          mainWebUi.openKeyBindingsTab();
        },
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        click(item, focusedWindow) {
          WebIpc.windowCloseRequest();
        },
        accelerator: 'Command+Q'
      }
    ]
  }];
  
  const topMenu = Menu.buildFromTemplate(template);
  
  Menu.setApplicationMenu(topMenu);
}

function handleConfigMessage(msg: Messages.Message): Promise<void> {
  const configMessage = <Messages.ConfigMessage> msg;
  const oldConfiguration = configManager.getConfig();
  const config = configMessage.config;
  configManager.setNewConfig(config);
  return setupConfiguration(oldConfiguration, config);
}

function handleThemeListMessage(msg: Messages.Message): void {
  const themesMessage = <Messages.ThemeListMessage> msg;
  themes = themesMessage.themeInfo
}

function handleThemeContentsMessage(msg: Messages.Message): void {
  const themeContentsMessage = <Messages.ThemeContentsMessage> msg;
  
  if (themeContentsMessage.success) {
    const cssFileMap = new Map<ThemeTypes.CssFile, string>();
    themeContentsMessage.cssFileList.forEach( (cssFile) => {
      cssFileMap.set(cssFile, themeContentsMessage.themeContents.cssFiles[ThemeTypes.cssFileNameBase(cssFile)]);
    });

    // Distribute the CSS files to the classes which want them.
    ThemeConsumer.updateCss(cssFileMap);
  } else {
    themeContentsError(themeContentsMessage);
  }
}

function themeContentsError(themeContentsMessage: Messages.ThemeContentsMessage): void {
  // Something went wrong.
  _log.warn(themeContentsMessage.errorMessage);
  
  if (themeContentsMessage.themeIdList.every( id => id === ThemeTypes.FALLBACK_UI_THEME)) {
    // Error occurred while trying to generate the default themes.
    window.alert("Something has gone wrong. The default theme couldn't be generated. Sorry.");
  } else {
    _log.warn("Attempting to use the default theme.");
    window.alert("Something has gone wrong while generating the theme. The default theme will be tried.");
    requestThemeContents(ThemeTypes.FALLBACK_TERMINAL_THEME, ThemeTypes.FALLBACK_SYNTAX_THEME, ThemeTypes.FALLBACK_UI_THEME);
  }
}

function handleDevToolsStatus(msg: Messages.Message): void {
  const devToolsStatusMessage = <Messages.DevToolsStatusMessage> msg;
  const developerToolMenu = <CbCheckBoxMenuItem> document.getElementById("developer_tools");
  if (developerToolMenu === null) {
    return;
  }
  developerToolMenu.setAttribute(CbCheckBoxMenuItem.ATTR_CHECKED, "" + devToolsStatusMessage.open);
}

function handleClipboardRead(msg: Messages.Message): void {
  const clipboardReadMessage = <Messages.ClipboardReadMessage> msg;
  mainWebUi.pasteText(clipboardReadMessage.text);
}

//-------------------------------------------------------------------------

/**
 * 
 */
function setupConfiguration(oldConfig: Config, newConfig: Config): Promise<void> {
  const keyBindingContexts = keybindingmanager.loadKeyBindingsFromObject(newConfig.systemConfig.keyBindingsContexts,
    process.platform);
  keyBindingManager.setKeyBindingContexts(keyBindingContexts);
  
  if (oldConfig === null || oldConfig.terminalFontSize !== newConfig.terminalFontSize ||
      oldConfig.terminalFont !== newConfig.terminalFont) {
        
    const matchingFonts = newConfig.systemConfig.availableFonts.filter(
      (font) => font.postscriptName === newConfig.terminalFont);
    setCssVars(newConfig.terminalFont, matchingFonts[0].path, newConfig.terminalFontSize);
  }

  if (oldConfig === null || oldConfig.themeTerminal !== newConfig.themeTerminal ||
      oldConfig.themeSyntax !== newConfig.themeSyntax ||
      oldConfig.themeGUI !== newConfig.themeGUI) {

    return requestThemeContents(newConfig.themeTerminal, newConfig.themeSyntax, newConfig.themeGUI);
  }
  
  // no-op promise.
  return new Promise<void>( (resolve, cancel) => { resolve(); } );
}

function requestThemeContents(themeTerminal: string, themeSyntax: string, themeGUI: string): Promise<void> {
  const terminalThemeIdList = [themeTerminal, ThemeTypes.FALLBACK_TERMINAL_THEME];
  const syntaxThemeIdList = [themeSyntax, ThemeTypes.FALLBACK_SYNTAX_THEME];
  const uiThemeIdList = [themeGUI, ThemeTypes.FALLBACK_UI_THEME];
  
  const cssFileMap = new Map<ThemeTypes.CssFile, string>();
  return WebIpc.requestThemeContents(terminalThemeIdList, ThemeTypes.TerminalCssFiles)
    .then( (result: Messages.ThemeContentsMessage): Promise<Messages.ThemeContentsMessage> => {
      if (result.success) {
        ThemeTypes.TerminalCssFiles.forEach( (cssFile: ThemeTypes.CssFile): void => {
          const key = ThemeTypes.cssFileNameBase(cssFile);
          cssFileMap.set(cssFile, result.themeContents.cssFiles[key]);
        });
      }
      return WebIpc.requestThemeContents(syntaxThemeIdList, ThemeTypes.SyntaxCssFiles);
    }, themeContentsError)
    .then( (result: Messages.ThemeContentsMessage): Promise<Messages.ThemeContentsMessage> => {
      if (result.success) {
        ThemeTypes.SyntaxCssFiles.forEach( (cssFile: ThemeTypes.CssFile): void => {
          const key = ThemeTypes.cssFileNameBase(cssFile);
          cssFileMap.set(cssFile, result.themeContents.cssFiles[key]);
        });
      }

      return WebIpc.requestThemeContents(uiThemeIdList, ThemeTypes.UiCssFiles);
    }, themeContentsError)
    .then( (result: Messages.ThemeContentsMessage): void => {
      if (result.success) {
        ThemeTypes.UiCssFiles.forEach( (cssFile: ThemeTypes.CssFile): void => {
          const key = ThemeTypes.cssFileNameBase(cssFile);
          cssFileMap.set(cssFile, result.themeContents.cssFiles[key]);
        });
      }
      
      // Distribute the CSS files to the classes which want them.
      ThemeConsumer.updateCss(cssFileMap);
    }, themeContentsError);
}

function reloadThemeContents(): void {
  const config = configManager.getConfig();
  requestThemeContents(config.themeTerminal, config.themeSyntax, config.themeGUI);
}

function setCssVars(fontName: string, fontPath: string, terminalFontSize: number): void {
  const fontCssName = fontName.replace(/\W/g, "_");
  (<HTMLStyleElement> document.getElementById('CSS_VARS')).textContent =
    `
    @font-face {
      font-family: "${fontCssName}";
      src: url("${fontPath}");
    }

    :root {
      --default-terminal-font-size: ${terminalFontSize}px;
      --terminal-font: "${fontCssName}";
    }
    `;
}

//-----------------------------------------------------------------------
//
//   #####                                               ######                                          
//  #     #  ####  #    # #    #   ##   #    # #####     #     #   ##   #      ###### ##### ##### ###### 
//  #       #    # ##  ## ##  ##  #  #  ##   # #    #    #     #  #  #  #      #        #     #   #      
//  #       #    # # ## # # ## # #    # # #  # #    #    ######  #    # #      #####    #     #   #####  
//  #       #    # #    # #    # ###### #  # # #    #    #       ###### #      #        #     #   #      
//  #     # #    # #    # #    # #    # #   ## #    #    #       #    # #      #        #     #   #      
//   #####   ####  #    # #    # #    # #    # #####     #       #    # ###### ######   #     #   ###### 
//                                                                                                      
//-----------------------------------------------------------------------
let commandPaletteRequestSource: HTMLElement = null;
let commandPaletteRequestEntries: CommandPaletteRequestTypes.CommandEntry[] = null;

function setUpCommandPalette(): void {
  const doc = window.document;

  // Command palette
  const commandPalette = <PopDownListPicker<CommandPaletteTypes.CommandEntry>> doc.createElement(PopDownListPicker.TAG_NAME);
  commandPalette.id = ID_COMMAND_PALETTE;
  commandPalette.setTitlePrimary("Command Palette");
  commandPalette.setTitleSecondary("Ctrl+Shift+P");

  commandPalette.setFilterAndRankEntriesFunc(commandPaletteFilterEntries);
  commandPalette.setFormatEntriesFunc(commandPaletteFormatEntries);
  commandPalette.addExtraCss([ThemeTypes.CssFile.GUI_COMMANDPALETTE]);

  doc.body.appendChild(commandPalette);
  commandPalette.addEventListener('selected', handleCommandPaletteSelected);
}    

function handleCommandPaletteRequest(request: CommandPaletteRequestTypes.CommandPaletteRequest): void {
  
  DomUtils.doLater( () => {
    commandPaletteRequestSource = request.srcElement;
    
    const entries = [...request.commandEntries, ...commandPaletteEntries()];
    commandPaletteRequestEntries = entries;
    const paletteEntries = entries.map( (entry, index): CommandPaletteTypes.CommandEntry => {
      return {
        id: "" + index,
        group: entry.group,
        iconLeft: entry.iconLeft,
        iconRight: entry.iconRight,
        label: entry.label,
        shortcut: entry.shortcut
      };
    });
    
    const commandPalette = <PopDownListPicker<CommandPaletteTypes.CommandEntry>> document.getElementById(ID_COMMAND_PALETTE);
    const shortcut = keyBindingManager.getKeyBindingContexts().context("main-ui").mapCommandToKeyBinding("openCommandPalette");
    commandPalette.setTitleSecondary(shortcut !== null ? shortcut : "");

    commandPalette.setEntries(paletteEntries);
    
    let rect: ClientRect = { left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500 };
    if (request.contextElement !== null && request.contextElement !== undefined) {
      rect = request.contextElement.getBoundingClientRect();
    }
    
    commandPalette.open(rect.left, rect.top, rect.width, rect.height);
    commandPalette.focus();
  });
}

function commandPaletteEntries(): CommandPaletteRequestTypes.CommandEntry[] {
  // Create a command target object which includes the tabInfo var.
  const target: CommandPaletteRequestTypes.Commandable = {
    executeCommand: executeCommand
  }

  const developerToolMenu = <CbCheckBoxMenuItem> document.getElementById("developer_tools");
  const devToolsOpen = util.toBoolean(developerToolMenu.getAttribute(CbCheckBoxMenuItem.ATTR_CHECKED));

  const commandList: CommandPaletteRequestTypes.CommandEntry[] = [
    { id: MENU_ITEM_SETTINGS, group: PALETTE_GROUP, iconRight: "wrench", label: "Settings", target: target },
    { id: MENU_ITEM_KEY_BINDINGS, group: PALETTE_GROUP, iconRight: "keyboard-o", label: "Key Bindings", target: target },
    { id: MENU_ITEM_DEVELOPER_TOOLS, group: PALETTE_GROUP, iconLeft: devToolsOpen ? "check-square-o" : "square-o", iconRight: "cogs", label: "Developer Tools", target: target },
    { id: MENU_ITEM_RELOAD_CSS, group: PALETTE_GROUP, iconRight: "refresh", label: "Reload Theme", target: target },
    { id: MENU_ITEM_ABOUT, group: PALETTE_GROUP, iconRight: "lightbulb-o", label: "About", target: target },
  ];
  return commandList;
}

function handleCommandPaletteSelected(ev: CustomEvent): void {
  const commandPalette = <PopDownListPicker<CommandPaletteTypes.CommandEntry>> document.getElementById(ID_COMMAND_PALETTE);
  commandPalette.close();
  if (commandPaletteRequestSource !== null) {
    commandPaletteRequestSource.focus();
  }
  
  const selectedId = ev.detail.selected;
  if (selectedId !== null) {
    const commandIndex = Number.parseInt(selectedId);
    const commandEntry = commandPaletteRequestEntries[commandIndex];
    DomUtils.doLater( () => {
      commandEntry.target.executeCommand(commandEntry.id);
      commandPaletteRequestSource = null;
      commandPaletteRequestEntries = null;
    });
  }
}

function commandPaletteFilterEntries(entries: CommandPaletteTypes.CommandEntry[], filter: string): CommandPaletteTypes.CommandEntry[] {
  const lowerFilter = filter.toLowerCase();
  return entries.filter( (entry) => entry.label.toLowerCase().includes(lowerFilter) );
}

function commandPaletteFormatEntries(entries: CommandPaletteTypes.CommandEntry[], selectedId: string, filterInputValue: string): string {
    return (filterInputValue.trim() === "" ? commandPaletteFormatEntriesWithGroups : commandPaletteFormatEntriesAsList)(entries, this._selectedId);
}

function commandPaletteFormatEntriesAsList(entries: CommandPaletteTypes.CommandEntry[], selectedId: string): string {
  return entries.map( (entry) => commandPaletteFormatEntry(entry, entry.id === selectedId) ).join("");
}

function commandPaletteFormatEntriesWithGroups(entries: CommandPaletteTypes.CommandEntry[], selectedId: string): string {
  let currentGroup: string = null;
  const htmlParts: string[] = [];

  for (let entry of entries) {
    let extraClass = "";
    if (entry.group !== currentGroup && currentGroup !== null) {
      extraClass = CLASS_RESULT_GROUP_HEAD;
    }
    currentGroup = entry.group;
    htmlParts.push(commandPaletteFormatEntry(entry, entry.id === selectedId, extraClass));
  }
  
  return htmlParts.join("");
}

function commandPaletteFormatEntry(entry: CommandPaletteTypes.CommandEntry, selected: boolean, extraClassString = ""): string {
  return `<div class='${PopDownListPicker.CLASS_RESULT_ENTRY} ${selected ? PopDownListPicker.CLASS_RESULT_SELECTED : ""} ${extraClassString}' ${PopDownListPicker.ATTR_DATA_ID}='${entry.id}'>
    <div class='${CLASS_RESULT_ICON_LEFT}'>${commandPaletteFormatIcon(entry.iconLeft)}</div>
    <div class='${CLASS_RESULT_ICON_RIGHT}'>${commandPaletteFormatIcon(entry.iconRight)}</div>
    <div class='${CLASS_RESULT_LABEL}'>${he.encode(entry.label)}</div>
    <div class='${CLASS_RESULT_SHORTCUT}'>${entry.shortcut !== undefined && entry.shortcut !== null ? he.encode(entry.shortcut) : ""}</div>
  </div>`;
}

function commandPaletteFormatIcon(iconName?: string): string {
  return `<i class='fa fa-fw ${iconName !== undefined && iconName !== null ? "fa-" + iconName : ""}'></i>`;
}

class ConfigManagerImpl implements ConfigManager {
  
  private _config: Config = null;
  
  private _listenerList: {key: any; onChange: ()=> void; }[] = [];  // Immutable list
  
  registerChangeListener(key: any, onChange: () => void): void {
    this._listenerList = [...this._listenerList, {key, onChange}];
  }
  
  unregisterChangeListener(key: any): void {
    this._listenerList = this._listenerList.filter( (tup) => tup.key !== key);
  }
  
  getConfig(): Config {
    return this._config;
  }
  
  setConfig(newConfig: Config): void {  
    WebIpc.sendConfig(newConfig);
  }
  
  /**
   * Set a new configuration object as the application wide 
   */
  setNewConfig(newConfig: Config): void {
    this._config = newConfig;
    
    const listenerList = this._listenerList;
    for (const tup of listenerList) {
      tup.onChange();
    }
  }
}

class KeyBindingManagerImpl {
  
  private _keyBindingContexts: KeyBindingContexts = null;
  
  private _listenerList: {key: any; onChange: ()=> void; }[] = [];  // Immutable list
  
  getKeyBindingContexts(): KeyBindingContexts {
    return this._keyBindingContexts;
  }
  
  setKeyBindingContexts(newKeyBindingContexts: KeyBindingContexts): void {
    this._keyBindingContexts = newKeyBindingContexts;
    
    const listenerList = this._listenerList;
    for (const tup of listenerList) {
      tup.onChange();
    }
  }
  
  /**
   * Register a listener to hear when the key bindings change.
   *
   * @param key an opaque object which is used to identify this registration.
   * @param onChange the function to call when the config changes.
   */
  registerChangeListener(key: any, onChange: () => void): void {
    this._listenerList = [...this._listenerList, {key, onChange}];
  }
  
  /**
   * Unregister a listener.
   *
   * @param key the same opaque object which was used during registerChangeListener().
   */
  unregisterChangeListener(key: any): void {
    this._listenerList = this._listenerList.filter( (tup) => tup.key !== key);
  }
}

class InternalExtratermApiImpl implements InternalExtratermApi.InternalExtratermApi {

  private _topLevelElement: HTMLElement = null;

  private _topLevelEventListeners: PluginApi.ElementListener[] = [];

  private _tabElements: HTMLElement[] = [];

  private _tabEventListeners: PluginApi.ElementListener[] = [];
 

  addNewTopLevelEventListener(callback: PluginApi.ElementListener): void {
    this._topLevelEventListeners.push(callback);
  }

  setTopLevel(el: HTMLElement): void {
    this._topLevelElement = el;
    this._topLevelEventListeners.forEach( listener => listener(el) );
  }

  addNewTabEventListener(callback: PluginApi.ElementListener): void {
    this._tabEventListeners.push(callback);
  }

  addTab(el: HTMLElement): void {
    this._tabElements.push(el);
    this._tabEventListeners.forEach( listener => listener(el) );
  }

  removeTab(el: HTMLElement): void {
    this._tabElements = this._tabElements.filter( listEl => listEl !== el );
  }
}
