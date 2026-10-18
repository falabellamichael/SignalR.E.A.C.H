Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "Sections.nsh"
Name "SignalREACH Suite"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Choose which SignalREACH components to install. Your existing settings are preserved.$\r$\n$\r$\nThe VS Code and SimpleRAG extensions require their host applications. Only the public, regular-user SimpleRAG extension is included."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
Page custom LaunchPage LaunchSelected
!insertmacro MUI_LANGUAGE "English"
Var StudioDone
Var TrayDone
Var CodeDone
Var RagDone
Var LaunchStudio
Var LaunchTray
Var LaunchVSCode
Var LaunchSimpleRag

Function .onInit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${PAYLOAD}\components.ps1"
  File "${PAYLOAD}\payload-manifest.json"
FunctionEnd

!macro CheckResult Component
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "${Component} could not be installed (exit code $0). See the installation details. Components already installed remain available. You can rerun Setup to retry." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

Section "Reach Studio" Studio
  SetOutPath "$PLUGINSDIR"
  File /oname=studio-setup.exe "${PAYLOAD}\studio-setup.exe"
  ExecWait '"$PLUGINSDIR\studio-setup.exe" /S /currentuser' $0
  !insertmacro CheckResult "Reach Studio"
  StrCpy $StudioDone 1
SectionEnd
Section "SimpleREACH extension for VS Code" Code
  SetOutPath "$PLUGINSDIR"
  File /oname=simplereach.vsix "${PAYLOAD}\simplereach.vsix"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\components.ps1" -Action InstallCode -Payload "$PLUGINSDIR\simplereach.vsix"'
  Pop $0
  !insertmacro CheckResult "VS Code extension"
  StrCpy $CodeDone 1
SectionEnd
Section "SimpleRAG extension (Public)" Rag
  SetOutPath "$PLUGINSDIR\public"
  File "${PAYLOAD}\public\manifest.json"
  File "${PAYLOAD}\public\manifest.js"
  File "${PAYLOAD}\public\reach-public.js"
  File "${PAYLOAD}\public\reach-public.css"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\components.ps1" -Action InstallPublic -Payload "$PLUGINSDIR\public"'
  Pop $0
  !insertmacro CheckResult "Public SimpleRAG extension"
  StrCpy $RagDone 1
SectionEnd
Section "SignalREACH system tray" Tray
  SetOutPath "$PLUGINSDIR"
  File /oname=tray-setup.exe "${PAYLOAD}\tray-setup.exe"
  ExecWait '"$PLUGINSDIR\tray-setup.exe" /S /currentuser' $0
  !insertmacro CheckResult "System tray"
  StrCpy $TrayDone 1
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
!insertmacro MUI_DESCRIPTION_TEXT ${Studio} "Desktop workspace for agent conversations, teams, files, and browsing."
!insertmacro MUI_DESCRIPTION_TEXT ${Code} "Installs SimpleREACH into an existing stable Microsoft VS Code installation."
!insertmacro MUI_DESCRIPTION_TEXT ${Rag} "Public REACH dashboard, model connections and Playground for SimpleRAG, with the shared Studio/VS Code settings hub."
!insertmacro MUI_DESCRIPTION_TEXT ${Tray} "Desktop tray for model endpoints and provider connections."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function LaunchPage
  !insertmacro MUI_HEADER_TEXT "Installation complete" "Choose which installed applications to open."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 32u "Extensions run inside their host applications. For SimpleRAG, reload the Advanced page to see SignalREACH."
  Pop $0
  ${NSD_CreateCheckbox} 0 42u 100% 16u "Launch Reach Studio"
  Pop $LaunchStudio
  ${If} $StudioDone != 1
    EnableWindow $LaunchStudio 0
  ${EndIf}
  ${NSD_CreateCheckbox} 0 66u 100% 16u "Open VS Code"
  Pop $LaunchVSCode
  ${If} $CodeDone != 1
    EnableWindow $LaunchVSCode 0
  ${EndIf}
  ${NSD_CreateCheckbox} 0 90u 100% 16u "Open SimpleRAG (if installed)"
  Pop $LaunchSimpleRag
  ${If} $RagDone != 1
    EnableWindow $LaunchSimpleRag 0
  ${EndIf}
  ${NSD_CreateCheckbox} 0 114u 100% 16u "Launch SignalREACH system tray"
  Pop $LaunchTray
  ${If} $TrayDone != 1
    EnableWindow $LaunchTray 0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

!macro LaunchHost Handle Action
  ${NSD_GetState} ${Handle} $0
  ${If} $0 == ${BST_CHECKED}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\components.ps1" -Action ${Action}'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "The host application could not be opened. Launch it from the Start menu. Installation is complete."
    ${EndIf}
  ${EndIf}
!macroend
Function LaunchSelected
  !insertmacro LaunchHost $LaunchStudio LaunchStudio
  !insertmacro LaunchHost $LaunchTray LaunchTray
  !insertmacro LaunchHost $LaunchVSCode LaunchCode
  !insertmacro LaunchHost $LaunchSimpleRag LaunchRag
FunctionEnd
