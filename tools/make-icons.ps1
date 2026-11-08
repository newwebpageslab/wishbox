# 앱 아이콘 PNG 생성 (Windows 기본 System.Drawing 사용)
Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot '..\icons'

function New-HeartPath([float]$s, [float]$scale) {
  # 512 기준 하트 좌표를 크기에 맞게 변환 (중앙 정렬)
  $o = ($s - 512 * $scale) / 2
  $p = { param($x, $y) New-Object System.Drawing.PointF(($o + $x * $scale), ($o + $y * $scale)) }
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddBezier((& $p 256 386), (& $p 256 386), (& $p 138 314), (& $p 110 242))
  $path.AddBezier((& $p 110 242), (& $p 91 193), (& $p 121 135), (& $p 177 135))
  $path.AddBezier((& $p 177 135), (& $p 210 135), (& $p 234 154), (& $p 256 182))
  $path.AddBezier((& $p 256 182), (& $p 278 154), (& $p 302 135), (& $p 335 135))
  $path.AddBezier((& $p 335 135), (& $p 391 135), (& $p 421 193), (& $p 402 242))
  $path.AddBezier((& $p 402 242), (& $p 374 314), (& $p 256 386), (& $p 256 386))
  $path.CloseFigure()
  return $path
}

function New-Icon([int]$size, [string]$file, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(255, 255, 92, 124), [System.Drawing.Color]::FromArgb(255, 255, 45, 85), 45)
  if ($maskable) {
    $g.FillRectangle($brush, $rect)   # 마스커블: 전체 채움, 하트는 안전 영역 안
    $heartScale = $size / 512 * 0.78
  } else {
    $r = $size * 112 / 512
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bg.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $bg.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $bg.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $bg.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $bg.CloseFigure()
    $g.FillPath($brush, $bg)
    $heartScale = $size / 512
  }
  $heart = New-HeartPath $size $heartScale
  $g.FillPath([System.Drawing.Brushes]::White, $heart)
  $bmp.Save((Join-Path $outDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Icon 192 'icon-192.png' $false
New-Icon 512 'icon-512.png' $false
New-Icon 512 'icon-maskable-512.png' $true
Write-Output 'icons created'
