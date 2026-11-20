!include "Win\COM.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef BUILD_UNINSTALLER
Var launchAsAdmin
Var adminCheckbox

!macro customHeader
  LangString AdminTitle ${LANG_KOREAN} "관리자 권한"
  LangString AdminTitle ${LANG_ENGLISH} "Administrator access"
  LangString AdminQuestion ${LANG_KOREAN} "청음을 관리자 권한으로 실행하도록 허용할까요?"
  LangString AdminQuestion ${LANG_ENGLISH} "Allow Cheongeum to request administrator access when opened?"
  LangString AdminOption ${LANG_KOREAN} "청음 바로 가기를 관리자 권한으로 실행"
  LangString AdminOption ${LANG_ENGLISH} "Run Cheongeum shortcuts as administrator"
  LangString AdminHelp ${LANG_KOREAN} "선택하면 시작 메뉴와 바탕 화면에서 청음을 열 때 Windows가 승인을 요청합니다. 마이크와 스피커는 일반 권한으로도 사용할 수 있습니다."
  LangString AdminHelp ${LANG_ENGLISH} "When selected, opening Cheongeum from Start or the desktop requests Windows approval. The microphone and speakers also work with standard access."
!macroend

!macro customInit
  ; Read before electron-builder removes the old version and its registry key.
  ReadRegDWORD $launchAsAdmin SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" LaunchAsAdmin
  ${If} $launchAsAdmin != 1
    StrCpy $launchAsAdmin 0
  ${EndIf}
  ${GetParameters} $0
  ${GetOptions} $0 "/ADMINLAUNCH=" $1
  ${IfNot} ${Errors}
    ${If} $1 == 1
      StrCpy $launchAsAdmin 1
    ${ElseIf} $1 == 0
      StrCpy $launchAsAdmin 0
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro customPageAfterChangeDir
  Page custom chooseAdminMode saveAdminMode
  Function chooseAdminMode
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$(AdminTitle)" "$(AdminQuestion)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 6u 100% 20u "$(AdminOption)"
    Pop $adminCheckbox
    ${NSD_SetState} $adminCheckbox $launchAsAdmin
    ${NSD_CreateLabel} 0 38u 100% 50u "$(AdminHelp)"
    Pop $0
    nsDialogs::Show
  FunctionEnd
  Function saveAdminMode
    ${NSD_GetState} $adminCheckbox $launchAsAdmin
  FunctionEnd
!macroend

; Edit only the elevation bit of the shortcuts installed by electron-builder.
; Keep their working directory, icon, arguments and AppUserModelID intact.
!macro applyLaunchMode link
  ${If} ${FileExists} "${link}"
    System::Store S
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
    ${If} $0 P<> 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
      ${If} $1 P<> 0
        ${IPersistFile::Load} $1 '("${link}",2).r4'
        ${If} $4 = 0
          ${IUnknown::QueryInterface} $0 '("${IID_IShellLinkDataList}",.r2)'
          ${If} $2 P<> 0
            ${IShellLinkDataList::GetFlags} $2 '(.r3)'
            ${If} $launchAsAdmin = 1
              IntOp $3 $3 | ${SLDF_RUNAS_USER}
            ${Else}
              IntOp $4 ${SLDF_RUNAS_USER} ~
              IntOp $3 $3 & $4
            ${EndIf}
            ${IShellLinkDataList::SetFlags} $2 '($3).r4'
            ${If} $4 = 0
              ${IPersistFile::Save} $1 '("${link}",1)'
            ${EndIf}
            ${IUnknown::Release} $2 ""
          ${EndIf}
        ${EndIf}
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
    System::Store L
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro applyLaunchMode "$newStartMenuLink"
  !insertmacro applyLaunchMode "$newDesktopLink"
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" LaunchAsAdmin $launchAsAdmin
!macroend
!endif
