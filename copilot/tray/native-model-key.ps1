param([Parameter(Mandatory=$true)][string]$Origin, [Parameter(Mandatory=$true)][string]$PipeName, [switch]$ValidateOnly, [switch]$PipeSelfTest)
$ErrorActionPreference = 'Stop'
$nativePipe = $null
$nativePassword = $null
try {
    $nativeUri = [Uri]$Origin
    if ($nativeUri.Scheme -ne 'https' -or $nativeUri.UserInfo -or $nativeUri.AbsolutePath -ne '/' -or $nativeUri.Query -or $nativeUri.Fragment) { throw 'Invalid origin' }
    if ($PipeName -notmatch '^signalreach-model-key-[a-f0-9-]{36}$') { throw 'Invalid pipe' }
    Add-Type -AssemblyName PresentationFramework
    $nativeSecurity = New-Object System.IO.Pipes.PipeSecurity
    $nativeSecurity.SetAccessRuleProtection($true, $false)
    $nativeUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $nativeRule = [System.IO.Pipes.PipeAccessRule]::new($nativeUser, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $nativeSecurity.AddAccessRule($nativeRule)
    $nativePipe = [System.IO.Pipes.NamedPipeServerStream]::new($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $nativeSecurity)
    if ($ValidateOnly) {
        $nativeProbePassword = New-Object System.Windows.Controls.PasswordBox
        $nativeProbePassword.PasswordChar = [char]0x25CF
        $nativeRules = @($nativePipe.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $nativeContract = @{ masked = ($nativeProbePassword.PasswordChar -eq [char]0x25CF); securePasswordType = $nativeProbePassword.SecurePassword.GetType().FullName; privatePipe = ($nativeRules.Count -eq 1 -and $nativeRules[0].IdentityReference.Value -eq $nativeUser.Value) }
        $nativeContract | ConvertTo-Json -Compress
        exit 0
    }
    [Console]::Out.Write("READY`n")
    $nativeWait = $nativePipe.BeginWaitForConnection($null, $null)
    if (-not $nativeWait.AsyncWaitHandle.WaitOne(20000)) { throw 'Private pipe timeout' }
    $nativePipe.EndWaitForConnection($nativeWait)
    if ($PipeSelfTest) {
        $nativeTestBytes = [System.Text.Encoding]::UTF8.GetBytes('synthetic-native-pipe-self-test')
        $nativePipe.Write($nativeTestBytes, 0, $nativeTestBytes.Length)
        $nativePipe.Flush()
        [Array]::Clear($nativeTestBytes, 0, $nativeTestBytes.Length)
        exit 0
    }

    $nativeWindow = New-Object System.Windows.Window
    $nativeWindow.Title = 'SignalREACH - model discovery key'
    $nativeWindow.Width = 550
    $nativeWindow.SizeToContent = [System.Windows.SizeToContent]::Height
    $nativeWindow.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $nativeWindow.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen
    $nativeWindow.Topmost = $true
    $nativeLayout = New-Object System.Windows.Controls.StackPanel
    $nativeLayout.Margin = New-Object System.Windows.Thickness(24)
    $nativeIntro = New-Object System.Windows.Controls.TextBlock
    $nativeIntro.Text = "Enter your relay API key for model discovery at:`n$Origin`n`nIt will be encrypted for this Windows account."
    $nativeIntro.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $nativeLayout.Children.Add($nativeIntro) | Out-Null
    $nativePassword = New-Object System.Windows.Controls.PasswordBox
    $nativePassword.PasswordChar = [char]0x25CF
    $nativePassword.MaxLength = 4096
    $nativePassword.Margin = New-Object System.Windows.Thickness(0,18,0,12)
    $nativePassword.Height = 34
    $nativeLayout.Children.Add($nativePassword) | Out-Null
    $nativeFeedback = New-Object System.Windows.Controls.TextBlock
    $nativeFeedback.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $nativeLayout.Children.Add($nativeFeedback) | Out-Null
    $nativeButtons = New-Object System.Windows.Controls.StackPanel
    $nativeButtons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
    $nativeButtons.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
    $nativeButtons.Margin = New-Object System.Windows.Thickness(0,16,0,0)
    $nativeCancel = New-Object System.Windows.Controls.Button
    $nativeCancel.Content = 'Cancel'
    $nativeCancel.IsCancel = $true
    $nativeCancel.Width = 90
    $nativeCancel.Margin = New-Object System.Windows.Thickness(0,0,10,0)
    $nativeSave = New-Object System.Windows.Controls.Button
    $nativeSave.Content = 'Save key'
    $nativeSave.IsDefault = $true
    $nativeSave.Width = 100
    $nativeButtons.Children.Add($nativeCancel) | Out-Null
    $nativeButtons.Children.Add($nativeSave) | Out-Null
    $nativeLayout.Children.Add($nativeButtons) | Out-Null
    $nativeWindow.Content = $nativeLayout
    $nativeCancel.Add_Click({ $nativeWindow.DialogResult = $false })
    $nativeSave.Add_Click({
        $nativePointer = [IntPtr]::Zero
        $nativeBytes = $null
        $nativeText = $null
        try {
            $nativePointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($nativePassword.SecurePassword)
            $nativeText = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($nativePointer)
            if ($nativeText -notmatch '^[\x21-\x7e]{1,4096}$') { $nativeFeedback.Text = 'Enter a valid relay API key without spaces or line breaks.'; return }
            $nativeBytes = [System.Text.Encoding]::UTF8.GetBytes($nativeText)
            # Only this private, current-user-only pipe carries plaintext to the
            # trusted Electron main process. It never enters the PS pipeline.
            $nativePipe.Write($nativeBytes, 0, $nativeBytes.Length)
            $nativePipe.Flush()
            $nativeWindow.DialogResult = $true
        } catch { $nativeFeedback.Text = 'Secure entry could not complete. Please cancel and try again.' }
        finally {
            if ($nativeBytes) { [Array]::Clear($nativeBytes, 0, $nativeBytes.Length) }
            if ($nativePointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($nativePointer) }
            $nativeText = $null
        }
    })
    $nativeWindow.Add_ContentRendered({ $nativePassword.Focus() | Out-Null })
    $nativeWindow.ShowDialog() | Out-Null
} catch {
    [Console]::Error.WriteLine('Native secure key entry is unavailable.')
    exit 1
} finally {
    if ($nativePassword) { $nativePassword.Clear() }
    if ($nativePipe) { $nativePipe.Dispose() }
}
