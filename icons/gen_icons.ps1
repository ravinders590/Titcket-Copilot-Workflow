Add-Type -AssemblyName System.Drawing
$sizes = @(16, 48, 128)
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $bgColor = [System.Drawing.Color]::FromArgb(255, 35, 134, 54)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillRectangle($bgBrush, 0, 0, $s, $s)
    $fgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fs = [float]($s * 0.55)
    $font = New-Object System.Drawing.Font("Arial", $fs, [System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
    $g.DrawString("C", $font, $fgBrush, $rect, $sf)
    $g.Dispose()
    $out = "d:\Remote.co\plugin\ticketCopilot\icons\icon$s.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created $out"
}
