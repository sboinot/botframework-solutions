function DeployLUIS ($name, $luFile, $region, $endpoint, $subscriptionKey, $culture, $log)
{
    $id = $luFile.BaseName
    $outFile = Join-Path $luFile.DirectoryName "$($id).json"
    $appName = "$($name)$($culture)_$($id)"
    
    Write-Host "> Running 'bf luis:convert' ..." -NoNewline
    bf luis:convert --name $appName --in $luFile --out $outFile --culture $culture --force
    Write-Host "Done." -ForegroundColor Green

    Write-Host "> Running 'bf luis:application:import --name $($appName) --in $($outFile)' ..." -NoNewline
    $result = bf luis:application:import --name $appName --in $outFile --endpoint $endpoint --subscriptionKey $subscriptionKey
    
    $pattern = "(\{){0,1}[0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{12}(\}){0,1}"
    $result -match $pattern

	if (-not $matches)
    {
		Write-Host "! Could not import LUIS application. Review the log for more information." -ForegroundColor DarkRed
		Write-Host "! Log: $($log)" -ForegroundColor DarkRed
		Return $null
	}
	else
    {
        $appId = $matches[0]
        Write-Host "Done." -ForegroundColor Green
        Write-Host "> Running 'bf luis:application:publish' ..." -NoNewline
        $(luis train version `
            --appId $appId `
            --region westus `
            --authoringKey $subscriptionKey `
            --versionId 0.1 `
            --wait
        & bf luis:application:publish `
            --appId $appId `
            --endpoint $endpoint `
            --subscriptionKey $subscriptionKey `
            --versionId 0.1) 2>> $log | Out-Null
        Write-Host "Done." -ForegroundColor Green

        Write-Host "> returning $($appId)"
		Return $appId
	}
}

function UpdateLUIS ($luFile, $appId, $region, $endpoint, $subscriptionKey, $version, $culture, $log)
{
    $id = $luFile.BaseName
    $outFile = Join-Path $luFile.DirectoryName "$($id).json"
  
    Write-Host "> Running 'bf luis:application:show' ..." -NoNewline
    $luisApp = bf luis:application:show --appId $appId --endpoint $endpoint --subscriptionKey $subscriptionKey | ConvertFrom-Json
    Write-Host "Done." -ForegroundColor Green

    Write-Host "> Running 'bf luis:convert' ..." -NoNewline
	bf luis:convert --name $luisApp.name --in $luFile --culture $luisApp.culture --out $outFile --force
    Write-Host "Done." -ForegroundColor Green

    Write-Host "> Running 'bf luis:version:list' ..." -NoNewline
	$versions = bf luis:version:list --appId $appId --endpoint $endpoint --subscriptionKey $subscriptionKey | ConvertFrom-Json
    Write-Host "Done." -ForegroundColor Green

    if ($versions | Where { $_.version -eq $version })
    {
        if ($versions | Where { $_.version -eq "backup" })
        {
            Write-Host "> Running 'bf luis:version:delete -versionId backup' ..." -NoNewline
            bf luis:version:delete --versionId "backup" --appId $appId --endpoint $endpoint --subscriptionKey $subscriptionKey
            Write-Host "Done." -ForegroundColor Green
        }
        
        Write-Host "> Running 'bf luis:version:rename --versionId $($version) --newVersionId backup' ..." -NoNewline
        bf luis:version:rename --versionId $version --newVersionId "backup" --appId $appId --endpoint $endpoint --subscriptionKey $subscriptionKey
        Write-Host "Done." -ForegroundColor Green
    }

    Write-Host "> Running 'bf luis:version:import --in $($outFile) --versionId $($version)' ..." -NoNewline
    bf luis:version:import --in $outFile --versionId $version --appId $appId --endpoint $endpoint --subscriptionKey $subscriptionKey

    Write-Host "> Running 'bf luis:application:publish' ..." -NoNewline
            $(luis train version `
            --appId $appId `
            --region westus `
            --authoringKey $subscriptionKey `
            --versionId 0.1 `
            --wait
        & bf luis:application:publish `
            --appId $appId `
            --endpoint $endpoint `
            --subscriptionKey $subscriptionKey `
            --versionId 0.1) 2>> $log | Out-Null
    Write-Host "Done." -ForegroundColor Green
}

function RunLuisGen($luFile, $outName, $outFolder, $log)
{
    $id = $luFile.BaseName
	$luisFolder = $luFile.DirectoryName
	$luisFile = Join-Path $luisFolder "$($id).json"

	bf luis:generate:cs `
        --in $luisFile `
        --className "$($outName)Luis" `
        --out $outFolder `
        --force 2>> $log | Out-Null
}