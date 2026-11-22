!macro customHeader
  ; 开启高 DPI 感知：PerMonitorV2 支持 Windows 10/11 多屏高清缩放，ManifestDPIAware 兼容旧版系统
  ManifestDPIAware true
  ManifestDPIAwareness PerMonitorV2

  ; 替换 NSIS 中文默认 9pt 宋体为微软雅黑 UI，消除高分屏文字发虚
  !ifdef LANG_SIMPCHINESE
    SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
  !endif
  !ifdef LANG_TRADCHINESE
    SetFont /LANG=${LANG_TRADCHINESE} "Microsoft JhengHei UI" 9
  !endif
!macroend
