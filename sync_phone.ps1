$ErrorActionPreference = "SilentlyContinue"
$DestinationBase = "D:\Panchami_RedmiNote9ProMax"
$Shell = New-Object -ComObject Shell.Application
$Computer = $Shell.Namespace(17) # This PC
$Phone = $Computer.Items() | Where-Object {$_.Name -like '*Redmi*'} | Select-Object -First 1

if (-not $Phone) {
    Write-Error "Phone 'Redmi Note 9 Pro Max' not found in This PC."
    exit
}

$SourceStorage = $Phone.GetFolder.Items() | Where-Object {$_.Name -match "Internal"} | Select-Object -First 1
if (-not $SourceStorage) {
    Write-Error "Internal shared storage not found."
    exit
}



Write-Host "--- Starting Backup Operation ---"
Write-Host "Source: $($SourceStorage.Path)"
Write-Host "Destination: $DestinationBase"

$FileList = New-Object System.Collections.Generic.List[PSObject]
$TotalSize = 0

function Get-FilesRecursive($FolderItem, $RelativePath) {
    $Folder = $FolderItem.GetFolder
    foreach ($Item in $Folder.Items()) {
        if ($Item.IsFolder) {
            $NewRelPath = Join-Path $RelativePath $Item.Name
            Get-FilesRecursive $Item $NewRelPath
        } else {
            $FileList.Add([PSCustomObject]@{
                Item = $Item
                RelativePath = $RelativePath
                Name = $Item.Name
                Size = $Item.Size
            })
            $script:TotalSize += $Item.Size
            if ($FileList.Count % 1000 -eq 0) {
                Write-Host "Scanned $($FileList.Count) files..."
            }
        }
    }
}

Write-Host "Scanning phone storage... please wait."
Get-FilesRecursive $SourceStorage ""

$TotalFiles = $FileList.Count
$TotalSizeGB = [math]::Round($TotalSize / 1GB, 2)
Write-Host "Scan Complete: $TotalFiles files found ($TotalSizeGB GB)."

$CopiedFiles = 0
$CopiedSize = 0
$LastReportedPercent = -5
$StartTime = Get-Date

Write-Host "Starting copy/sync process..."

foreach ($FileEntry in $FileList) {
    $DestFolder = Join-Path $DestinationBase $FileEntry.RelativePath
    if (-not (Test-Path $DestFolder)) {
        New-Item -ItemType Directory -Path $DestFolder -Force | Out-Null
    }

    $DestFilePath = Join-Path $DestFolder $FileEntry.Name
    $ShouldCopy = $true

    if (Test-Path $DestFilePath) {
        $DestFile = Get-Item $DestFilePath
        if ($DestFile.Length -eq $FileEntry.Size) {
            $ShouldCopy = $false
        }
    }

    if ($ShouldCopy) {
        $DestFolderObj = $Shell.Namespace($DestFolder)
        # 16 = Yes to all, 1024 = No progress UI, 4 = No progress dialog (sometimes 1024 doesn't work alone)
        $DestFolderObj.CopyHere($FileEntry.Item.Path, 16 + 1024)
    }

    $CopiedFiles++
    $CopiedSize += $FileEntry.Size
    $CurrentPercent = [math]::Floor(($CopiedFiles / $TotalFiles) * 100)

    if ($CurrentPercent -ge ($LastReportedPercent + 5)) {
        $Elapsed = (Get-Date) - $StartTime
        $SecsPerFile = if ($CopiedFiles -gt 0) { $Elapsed.TotalSeconds / $CopiedFiles } else { 0 }
        $RemainingSecs = $SecsPerFile * ($TotalFiles - $CopiedFiles)
        $ETA = [TimeSpan]::FromSeconds($RemainingSecs)
        
        Write-Host "Progress: $CurrentPercent% ($CopiedFiles/$TotalFiles files) - ETA: $($ETA.ToString('hh\:mm\:ss'))"
        $LastReportedPercent = [math]::Floor($CurrentPercent / 5) * 5
    }
}

Write-Host "--- Backup Completed ---"
$FinalElapsed = (Get-Date) - $StartTime
Write-Host "Total Files: $TotalFiles"
Write-Host "Total Time: $($FinalElapsed.ToString('hh\:mm\:ss'))"
