param([string]$Config = ".postula-agent\postula-agent-config.json")

$ErrorActionPreference = 'Stop'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $script:RepoRoot
$script:ConfigPath = if ([System.IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $script:RepoRoot $Config }
$script:ApiBase = 'http://127.0.0.1:4179'
$script:AgentProcess = $null
$script:OwnsAgent = $false
$script:LastData = $null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PostulaWindowPropertyKey {
  public Guid FormatId;
  public uint PropertyId;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PostulaWindowPropVariant {
  [FieldOffset(0)] public ushort VariantType;
  [FieldOffset(8)] public IntPtr Pointer;
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface PostulaWindowPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PostulaWindowPropertyKey key);
  [PreserveSig] int GetValue(ref PostulaWindowPropertyKey key, out PostulaWindowPropVariant value);
  [PreserveSig] int SetValue(ref PostulaWindowPropertyKey key, ref PostulaWindowPropVariant value);
  [PreserveSig] int Commit();
}

public static class PostulaTaskbarIdentity {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

  [DllImport("shell32.dll", PreserveSig = true)]
  private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out PostulaWindowPropertyStore store);

  [DllImport("ole32.dll", PreserveSig = true)]
  private static extern int PropVariantClear(ref PostulaWindowPropVariant value);

  public static void SetWindowAppUserModelID(IntPtr window, string appId) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    PostulaWindowPropertyStore store;
    int result = SHGetPropertyStoreForWindow(window, ref iid, out store);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    PostulaWindowPropertyKey key = new PostulaWindowPropertyKey {
      FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      PropertyId = 5
    };
    PostulaWindowPropVariant value = new PostulaWindowPropVariant {
      VariantType = 31,
      Pointer = Marshal.StringToCoTaskMemUni(appId)
    };
    try {
      result = store.SetValue(ref key, ref value);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      result = store.Commit();
      if (result < 0) Marshal.ThrowExceptionForHR(result);
    } finally {
      PropVariantClear(ref value);
      Marshal.ReleaseComObject(store);
    }
  }

  public static string GetWindowAppUserModelID(IntPtr window) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    PostulaWindowPropertyStore store;
    int result = SHGetPropertyStoreForWindow(window, ref iid, out store);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    PostulaWindowPropertyKey key = new PostulaWindowPropertyKey {
      FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      PropertyId = 5
    };
    PostulaWindowPropVariant value;
    try {
      result = store.GetValue(ref key, out value);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      try { return value.VariantType == 31 ? Marshal.PtrToStringUni(value.Pointer) : null; }
      finally { PropVariantClear(ref value); }
    } finally {
      Marshal.ReleaseComObject(store);
    }
  }
}
'@
[void][PostulaTaskbarIdentity]::SetCurrentProcessExplicitAppUserModelID('Ignacio.Postula.Desktop')

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

$xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Postula · Agente" Height="850" Width="1220" MinHeight="700" MinWidth="900"
        WindowStartupLocation="CenterScreen" Background="#F4F3F1" FontFamily="Segoe UI">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Foreground" Value="#171715"/><Setter Property="Background" Value="#FFFFFF"/>
      <Setter Property="BorderBrush" Value="#DCDAD6"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="13,8"/><Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="buttonBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="buttonBorder" Property="Background" Value="#F1F0EE"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="buttonBorder" Property="Opacity" Value="0.55"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="PrimaryButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Foreground" Value="#FFFFFF"/><Setter Property="Background" Value="#1D1F20"/><Setter Property="BorderBrush" Value="#1D1F20"/>
    </Style>
  </Window.Resources>
  <DockPanel>
    <Border DockPanel.Dock="Top" Height="66" Background="#F4F3F1" BorderBrush="#E5E3DF" BorderThickness="0,0,0,1">
      <Grid Margin="28,0">
        <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <Image x:Name="BrandIcon" Width="29" Height="29" Margin="0,0,9,0"/>
          <TextBlock Text="postula" FontSize="20" FontWeight="Bold" Foreground="#171715" VerticalAlignment="Center"/>
          <TextBlock Text="." FontSize="20" FontWeight="Bold" Foreground="#648A69" Margin="-6,0,0,0" VerticalAlignment="Center"/>
          <Border Width="1" Height="22" Background="#DCDAD6" Margin="14,0"/>
          <TextBlock Text="AGENTE DE ESCRITORIO" FontSize="11" Foreground="#5F5D59" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
          <Ellipse x:Name="ConnectionDot" Width="8" Height="8" Fill="#9A978F" Margin="0,0,8,0"/>
          <TextBlock x:Name="ConnectionLabel" Text="Conectando…" FontSize="12" Foreground="#5F5D59" VerticalAlignment="Center" Margin="0,0,18,0"/>
          <Button x:Name="ConfigureButton" Content="Configurar CV y búsqueda" Margin="0,0,10,0"/>
          <Button x:Name="AgentToggle" Content="Detener agente" MinWidth="120"/>
        </StackPanel>
      </Grid>
    </Border>
    <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
      <StackPanel Margin="28,23,28,30">
        <Grid Margin="0,0,0,19">
          <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel>
            <TextBlock Text="Actividad del agente" FontSize="25" FontWeight="SemiBold" Foreground="#171715"/>
            <TextBlock Text="Seguimiento local de ofertas, formularios y candidaturas confirmadas." FontSize="13" Foreground="#5F5D59" Margin="0,5,0,0"/>
          </StackPanel>
          <TextBlock x:Name="UpdatedLabel" Grid.Column="1" Text="Esperando datos" FontSize="12" Foreground="#5F5D59" VerticalAlignment="Bottom"/>
        </Grid>

        <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8" Padding="0" Margin="0,0,0,16">
          <Grid Height="62">
            <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/></Grid.ColumnDefinitions>
            <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step1Index" Text="1" FontSize="12" Foreground="#1D5FBF" Margin="0,0,9,0"/><TextBlock x:Name="Step1" Text="Buscar ofertas" FontSize="13" Foreground="#171715"/></StackPanel>
            <Border Grid.Column="1" Background="#EEEBE8"/>
            <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step2Index" Text="2" FontSize="12" Foreground="#6B6964" Margin="0,0,9,0"/><TextBlock x:Name="Step2" Text="Validar encaje" FontSize="13" Foreground="#6B6964"/></StackPanel>
            <Border Grid.Column="3" Background="#EEEBE8"/>
            <StackPanel Grid.Column="4" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step3Index" Text="3" FontSize="12" Foreground="#6B6964" Margin="0,0,9,0"/><TextBlock x:Name="Step3" Text="Completar solicitud" FontSize="13" Foreground="#6B6964"/></StackPanel>
            <Border Grid.Column="5" Background="#EEEBE8"/>
            <StackPanel Grid.Column="6" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step4Index" Text="4" FontSize="12" Foreground="#6B6964" Margin="0,0,9,0"/><TextBlock x:Name="Step4" Text="Confirmar y enviar" FontSize="13" Foreground="#6B6964"/></StackPanel>
          </Grid>
        </Border>

        <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8" Margin="0,0,0,22">
          <Grid>
            <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/></Grid.ColumnDefinitions>
            <StackPanel Grid.Column="0" Margin="18,14"><TextBlock Text="Ofertas vistas" FontSize="13" Foreground="#5F5D59"/><TextBlock x:Name="MetricProcessed" Text="0" FontSize="25" Foreground="#171715" Margin="0,3,0,0"/><TextBlock Text="desde que inició el agente" FontSize="12" Foreground="#6B6964" Margin="0,2,0,0"/></StackPanel>
            <Border Grid.Column="1" Background="#EEEBE8"/>
            <StackPanel Grid.Column="2" Margin="18,14"><TextBlock Text="Compatibles en este ciclo" FontSize="13" Foreground="#5F5D59"/><TextBlock x:Name="MetricMatched" Text="0" FontSize="25" Foreground="#171715" Margin="0,3,0,0"/><TextBlock Text="con el encaje configurado" FontSize="12" Foreground="#6B6964" Margin="0,2,0,0"/></StackPanel>
            <Border Grid.Column="3" Background="#EEEBE8"/>
            <StackPanel Grid.Column="4" Margin="18,14"><TextBlock Text="Formularios listos" FontSize="13" Foreground="#5F5D59"/><TextBlock x:Name="MetricReady" Text="0" FontSize="25" Foreground="#171715" Margin="0,3,0,0"/><TextBlock Text="esperando una confirmación" FontSize="12" Foreground="#6B6964" Margin="0,2,0,0"/></StackPanel>
            <Border Grid.Column="5" Background="#EEEBE8"/>
            <StackPanel Grid.Column="6" Margin="18,14"><TextBlock Text="Postulaciones confirmadas" FontSize="13" Foreground="#5F5D59"/><TextBlock x:Name="MetricSubmitted" Text="0" FontSize="25" Foreground="#171715" Margin="0,3,0,0"/><TextBlock Text="el portal mostró confirmación" FontSize="12" Foreground="#6B6964" Margin="0,2,0,0"/></StackPanel>
          </Grid>
        </Border>

        <Grid>
          <Grid.ColumnDefinitions><ColumnDefinition Width="1.55*"/><ColumnDefinition Width="20"/><ColumnDefinition Width="1*"/></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0">
            <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8" Margin="0,0,0,18">
              <StackPanel>
                <Grid Margin="18,15,18,12"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="Ahora" FontSize="15" FontWeight="SemiBold" Foreground="#171715"/><TextBlock x:Name="PhaseLabel" Text="Leyendo el estado del agente" FontSize="12" Foreground="#5F5D59" Margin="0,3,0,0"/></StackPanel><TextBlock x:Name="WorkLabel" Grid.Column="1" Text="En espera" FontSize="12" Foreground="#247B50" VerticalAlignment="Center"/></Grid>
                <Border Height="1" Background="#EEEBE8" Margin="18,0"/>
                <StackPanel Margin="18,13,18,18"><TextBlock x:Name="CurrentStage" Text="Esperando actividad" FontSize="14" FontWeight="SemiBold" Foreground="#171715"/><Grid Margin="0,10,0,0"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock x:Name="CurrentRole" Text="Todavía no hay una oferta en revisión." FontSize="14" Foreground="#171715" TextWrapping="Wrap"/><TextBlock x:Name="CurrentCompany" Text="" FontSize="12" Foreground="#5F5D59" Margin="0,3,0,0"/></StackPanel><TextBlock x:Name="CurrentMatch" Grid.Column="1" Text="" FontSize="12" Foreground="#5F5D59" VerticalAlignment="Top" Margin="16,0,0,0"/></Grid></StackPanel>
              </StackPanel>
            </Border>
            <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8">
              <StackPanel><StackPanel Margin="18,15,18,11"><TextBlock Text="Actividad reciente" FontSize="15" FontWeight="SemiBold" Foreground="#171715"/><TextBlock Text="Resultado por oferta procesada" FontSize="12" Foreground="#5F5D59" Margin="0,3,0,0"/></StackPanel><Border Height="1" Background="#EEEBE8" Margin="18,0,18,0"/><StackPanel x:Name="RecentHost" Margin="18,4,18,8"><TextBlock Text="Todavía no se procesaron ofertas." FontSize="13" Foreground="#5F5D59" Margin="0,10"/></StackPanel></StackPanel>
            </Border>
          </StackPanel>

          <StackPanel Grid.Column="2">
            <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8" Margin="0,0,0,18">
              <StackPanel><StackPanel Margin="18,15,18,11"><TextBlock Text="Ofertas que coinciden" FontSize="15" FontWeight="SemiBold" Foreground="#171715"/><TextBlock Text="Ranking TF-IDF local · elegibilidad remota desde Argentina" FontSize="12" Foreground="#5F5D59" Margin="0,3,0,0"/></StackPanel><Border Height="1" Background="#EEEBE8" Margin="18,0,18,0"/><StackPanel x:Name="MatchesHost" Margin="18,12,18,18"><TextBlock Text="Configurá tu CV y tocá Buscar ahora para ver resultados." FontSize="13" Foreground="#5F5D59" TextWrapping="Wrap"/></StackPanel></StackPanel>
            </Border>
            <Border x:Name="ApprovalCard" Background="#FFFFFF" BorderBrush="#1D5FBF" BorderThickness="1,2,1,1" CornerRadius="8" Margin="0,0,0,18">
              <StackPanel><StackPanel Margin="18,15,18,11"><TextBlock Text="Listas para enviar" FontSize="15" FontWeight="SemiBold" Foreground="#171715"/><TextBlock Text="Revisá la empresa y el puesto antes de cada envío." FontSize="12" Foreground="#5F5D59" Margin="0,3,0,0" TextWrapping="Wrap"/></StackPanel><Border Height="1" Background="#EEEBE8" Margin="18,0,18,0"/><StackPanel x:Name="ApprovalHost" Margin="18,12,18,18"><TextBlock Text="No hay formularios esperando confirmación." FontSize="13" Foreground="#5F5D59" TextWrapping="Wrap"/></StackPanel></StackPanel>
            </Border>
            <Border Background="#FFFFFF" BorderBrush="#E5E3DF" BorderThickness="1" CornerRadius="8" Padding="18">
              <StackPanel><TextBlock Text="Cómo opera" FontSize="15" FontWeight="SemiBold" Foreground="#171715"/><TextBlock Text="El CV se analiza en esta computadora. Python consulta RSS públicos y extrae avisos JobPosting; TF-IDF ordena el encaje sin tokens de IA. Abrí el formulario oficial desde cada oferta y completá el envío allí. El agente puede completar formularios compatibles; CAPTCHA y datos desconocidos quedan para revisión humana." FontSize="12" Foreground="#5F5D59" Margin="0,3,0,10" TextWrapping="Wrap"/></StackPanel>
            </Border>
          </StackPanel>
        </Grid>
        <TextBlock Text="Postula · Agente de escritorio · tu perfil y tu CV no se suben al panel" FontSize="11" Foreground="#6B6964" Margin="1,18,0,0"/>
      </StackPanel>
    </ScrollViewer>
  </DockPanel>
</Window>
'@

if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
  [System.Windows.MessageBox]::Show("No encuentro el perfil local:`n$($script:ConfigPath)`n`nGuardá postula-agent-config.json dentro de .postula-agent e iniciá de nuevo.", 'Postula', 'OK', 'Warning') | Out-Null
  exit 1
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  [System.Windows.MessageBox]::Show('Instalá Node.js 20 o superior para ejecutar Postula.', 'Postula', 'OK', 'Error') | Out-Null
  exit 1
}

[xml]$xaml = $xamlText
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$window.Add_SourceInitialized({
  $windowHandle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  [PostulaTaskbarIdentity]::SetWindowAppUserModelID($windowHandle, 'Ignacio.Postula.Desktop')
  if ([PostulaTaskbarIdentity]::GetWindowAppUserModelID($windowHandle) -ne 'Ignacio.Postula.Desktop') {
    throw 'Windows did not assign Postula taskbar identity to the desktop window.'
  }
})
$iconPath = Join-Path $script:RepoRoot 'assets\postula-icon.ico'
if (Test-Path -LiteralPath $iconPath) {
  $iconUri = New-Object System.Uri($iconPath)
  $iconFrame = [System.Windows.Media.Imaging.BitmapFrame]::Create($iconUri)
  $window.Icon = $iconFrame
  $window.FindName('BrandIcon').Source = $iconFrame
}
$script:ConnectionDot = $window.FindName('ConnectionDot')
$script:ConnectionLabel = $window.FindName('ConnectionLabel')
$script:UpdatedLabel = $window.FindName('UpdatedLabel')
$script:PhaseLabel = $window.FindName('PhaseLabel')
$script:WorkLabel = $window.FindName('WorkLabel')
$script:CurrentStage = $window.FindName('CurrentStage')
$script:CurrentRole = $window.FindName('CurrentRole')
$script:CurrentCompany = $window.FindName('CurrentCompany')
$script:CurrentMatch = $window.FindName('CurrentMatch')
$script:MetricProcessed = $window.FindName('MetricProcessed')
$script:MetricMatched = $window.FindName('MetricMatched')
$script:MetricReady = $window.FindName('MetricReady')
$script:MetricSubmitted = $window.FindName('MetricSubmitted')
$script:RecentHost = $window.FindName('RecentHost')
$script:MatchesHost = $window.FindName('MatchesHost')
$script:ApprovalHost = $window.FindName('ApprovalHost')
$script:ConfigureButton = $window.FindName('ConfigureButton')
$script:AgentToggle = $window.FindName('AgentToggle')
$script:Steps = @(
  $window.FindName('Step1'), $window.FindName('Step2'), $window.FindName('Step3'), $window.FindName('Step4'),
  $window.FindName('Step1Index'), $window.FindName('Step2Index'), $window.FindName('Step3Index'), $window.FindName('Step4Index')
)
$script:InkBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#171715')
$script:MutedBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#6B6964')
$script:BlueBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#1D5FBF')
$script:GreenBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#247B50')
$script:GrayBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#9A978F')

function Test-AgentApi {
  try { Invoke-RestMethod -Uri "$($script:ApiBase)/api/status" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

function Start-PostulaAgent {
  if (Test-AgentApi) { return }
  $node = (Get-Command node.exe).Source
  $logDirectory = Join-Path $script:RepoRoot '.postula-agent'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $stdout = Join-Path $logDirectory 'desktop-agent.log'
  $stderr = Join-Path $logDirectory 'desktop-agent-error.log'
  $argumentLine = "agent/runner.mjs `"$($script:ConfigPath)`""
  $script:AgentProcess = Start-Process -FilePath $node -ArgumentList $argumentLine -WorkingDirectory $script:RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $script:OwnsAgent = $true
}

function Invoke-PostulaApi([string]$Route, $Payload = $null) {
  $parameters = @{ Uri = "$($script:ApiBase)$Route"; Method = 'Post'; TimeoutSec = 60; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $Payload) {
    $json = ConvertTo-Json -InputObject $Payload -Depth 20 -Compress
    $parameters.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  try { return Invoke-RestMethod @parameters }
  catch {
    $response = $_.Exception.Response
    if ($response) {
      try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd(); $reader.Dispose()
        if ($body) {
          try { $detail = (ConvertFrom-Json $body).error } catch { $detail = $body }
          if ($detail) { throw [System.InvalidOperationException]::new([string]$detail) }
        }
      } catch { if ($_.Exception -is [System.InvalidOperationException]) { throw } }
    }
    throw
  }
}

function Add-ProfileField($Panel, [string]$Label, [string]$Value, [int]$Height = 38) {
  $caption = New-Object System.Windows.Controls.TextBlock
  $caption.Text = $Label; $caption.FontSize = 12; $caption.Foreground = $script:MutedBrush; $caption.Margin = '0,10,0,5'
  [void]$Panel.Children.Add($caption)
  $inputBox = New-Object System.Windows.Controls.TextBox
  $inputBox.Text = $Value; $inputBox.Height = $Height; $inputBox.FontSize = 13; $inputBox.Padding = '9,7'; $inputBox.VerticalContentAlignment = 'Center'
  if ($Height -gt 50) { $inputBox.AcceptsReturn = $true; $inputBox.TextWrapping = 'Wrap'; $inputBox.VerticalScrollBarVisibility = 'Auto'; $inputBox.VerticalContentAlignment = 'Top' }
  [void]$Panel.Children.Add($inputBox)
  return $inputBox
}

function Show-ProfileDialog {
  try { $saved = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json; $p = $saved.profile } catch { $saved = [pscustomobject]@{}; $p = [pscustomobject]@{} }
  $dialog = New-Object System.Windows.Window
  $dialog.Title = 'Configurá tu perfil y búsqueda · Postula'; $dialog.Width = 720; $dialog.Height = 820; $dialog.MinWidth = 620; $dialog.MinHeight = 640
  $dialog.WindowStartupLocation = 'CenterOwner'; $dialog.Owner = $window; $dialog.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F4F3F1')
  $outer = New-Object System.Windows.Controls.DockPanel; $dialog.Content = $outer
  $actions = New-Object System.Windows.Controls.StackPanel; $actions.Orientation = 'Horizontal'; $actions.HorizontalAlignment = 'Right'; $actions.Margin = '22,12,22,16'
  [System.Windows.Controls.DockPanel]::SetDock($actions, 'Bottom'); [void]$outer.Children.Add($actions)
  $cancel = New-Object System.Windows.Controls.Button; $cancel.Content = 'Cancelar'; $cancel.Margin = '0,0,9,0'; $cancel.Add_Click({ $dialog.Close() }.GetNewClosure()); [void]$actions.Children.Add($cancel)
  $save = New-Object System.Windows.Controls.Button; $save.Content = 'Guardar y buscar ahora'; $save.Style = $window.FindResource('PrimaryButton'); [void]$actions.Children.Add($save)
  $scroll = New-Object System.Windows.Controls.ScrollViewer; $scroll.VerticalScrollBarVisibility = 'Auto'; [void]$outer.Children.Add($scroll)
  $form = New-Object System.Windows.Controls.StackPanel; $form.Margin = '25,22,25,12'; $scroll.Content = $form
  $heading = New-Object System.Windows.Controls.TextBlock; $heading.Text = 'Prepará tu búsqueda'; $heading.FontSize = 23; $heading.FontWeight = 'SemiBold'; $heading.Foreground = $script:InkBrush; [void]$form.Children.Add($heading)
  $intro = New-Object System.Windows.Controls.TextBlock; $intro.Text = 'Cargá el CV y elegí qué querés buscar. Postula extrae el texto y calcula el encaje en esta computadora, sin mandar tu CV a una IA.'; $intro.FontSize = 13; $intro.Foreground = $script:MutedBrush; $intro.TextWrapping = 'Wrap'; $intro.Margin = '0,5,0,8'; [void]$form.Children.Add($intro)
  $name = Add-ProfileField $form 'Nombre y apellido' ([string]$p.name)
  $email = Add-ProfileField $form 'Email' ([string]$p.email)
  $roles = Add-ProfileField $form 'Puestos (separados por coma)' ([string]$p.roles)
  $location = Add-ProfileField $form 'Ubicación' ($(if ($p.location) { [string]$p.location } else { 'Buenos Aires, Argentina' }))
  $mode = Add-ProfileField $form 'Modalidad' ($(if ($p.mode) { [string]$p.mode } else { 'Remoto' }))
  $minMatch = Add-ProfileField $form 'Encaje mínimo (%)' ([string]$(if ($saved.settings.minimumMatch) { $saved.settings.minimumMatch } else { 60 }))
  $interval = Add-ProfileField $form 'Revisar ofertas cada (minutos, desde 1)' ([string]$(if ($saved.settings.intervalMinutes) { $saved.settings.intervalMinutes } else { 30 }))
  $searchNote = New-Object System.Windows.Controls.TextBlock; $searchNote.Text = 'La frecuencia controla los ciclos de revisión. Las fuentes externas usan caché y sus propios ritmos para evitar consultas repetidas.'; $searchNote.FontSize = 11; $searchNote.Foreground = $script:MutedBrush; $searchNote.TextWrapping = 'Wrap'; [void]$form.Children.Add($searchNote)
  $dailyLimit = Add-ProfileField $form 'Máximo diario de postulaciones enviadas (separado de búsquedas)' ([string]$(if ($saved.settings.dailyLimit) { $saved.settings.dailyLimit } elseif ($p.dailyLimit) { $p.dailyLimit } else { 5 }))
  $cvHeading = New-Object System.Windows.Controls.TextBlock; $cvHeading.Text = 'CV · análisis local'; $cvHeading.FontSize = 16; $cvHeading.FontWeight = 'SemiBold'; $cvHeading.Foreground = $script:InkBrush; $cvHeading.Margin = '0,18,0,4'; [void]$form.Children.Add($cvHeading)
  $cvNote = New-Object System.Windows.Controls.TextBlock; $cvNote.Text = 'PDF o TXT · máximo 8 MB. El texto extraído se guarda en el archivo local de configuración y se usa para el ranking TF-IDF.'; $cvNote.FontSize = 12; $cvNote.Foreground = $script:MutedBrush; $cvNote.TextWrapping = 'Wrap'; [void]$form.Children.Add($cvNote)
  $cvRow = New-Object System.Windows.Controls.StackPanel; $cvRow.Orientation = 'Horizontal'; $cvRow.Margin = '0,10,0,3'; [void]$form.Children.Add($cvRow)
  $chooseCv = New-Object System.Windows.Controls.Button; $chooseCv.Content = 'Cargar y analizar CV'; [void]$cvRow.Children.Add($chooseCv)
  $fileLabel = New-Object System.Windows.Controls.TextBlock; $fileLabel.Text = if ($p.resume) { 'CV guardado localmente' } else { 'Todavía no cargaste un CV' }; $fileLabel.VerticalAlignment = 'Center'; $fileLabel.Margin = '10,0,0,0'; $fileLabel.Foreground = $script:MutedBrush; [void]$cvRow.Children.Add($fileLabel)
  $resume = Add-ProfileField $form 'Texto del CV' ([string]$p.resume) 220
  $summary = Add-ProfileField $form 'Resumen profesional (opcional)' ([string]$p.summary) 90
  $skills = Add-ProfileField $form 'Habilidades (opcional)' ([string]$p.skills) 64
  $chooseCv.Add_Click({
    $picker = New-Object Microsoft.Win32.OpenFileDialog; $picker.Title = 'Elegí tu CV'; $picker.Filter = 'CV PDF o texto (*.pdf;*.txt)|*.pdf;*.txt'; $picker.CheckFileExists = $true
    if ($picker.ShowDialog($dialog) -ne $true) { return }
    $info = Get-Item -LiteralPath $picker.FileName
    if ($info.Length -gt 8MB) { [System.Windows.MessageBox]::Show('El CV supera el límite de 8 MB.', 'Postula') | Out-Null; return }
    try {
      $bytes = [System.IO.File]::ReadAllBytes($picker.FileName)
      $analysis = Invoke-PostulaApi '/api/analyze-cv' @{ fileName = $info.Name; contentBase64 = [Convert]::ToBase64String($bytes) }
      $resume.Text = [string]$analysis.text; $fileLabel.Text = "Analizado: $($info.Name) · $($analysis.skills.Count) habilidades detectadas"
      if (-not $name.Text.Trim() -and $analysis.name) { $name.Text = [string]$analysis.name }
      if (-not $email.Text.Trim() -and $analysis.email) { $email.Text = [string]$analysis.email }
      if (-not $p.phone -and $analysis.phone) { $p | Add-Member -NotePropertyName phone -NotePropertyValue ([string]$analysis.phone) -Force }
      if ($analysis.skills.Count) { $skills.Text = (@($skills.Text -split ',\s*') + @($analysis.skills) | Where-Object { $_ } | Select-Object -Unique) -join ', ' }
    } catch { [System.Windows.MessageBox]::Show("No pude analizar el CV:`n$($_.Exception.Message)", 'Postula', 'OK', 'Warning') | Out-Null }
  }.GetNewClosure())
  $save.Add_Click({
    $button = $save; $button.IsEnabled = $false; $button.Content = 'Guardando y buscando…'
    try {
      $dailyLimitValue = 0
      if (-not [int]::TryParse($dailyLimit.Text, [ref]$dailyLimitValue) -or $dailyLimitValue -lt 1 -or $dailyLimitValue -gt 20) { throw 'El máximo diario debe ser un número entre 1 y 20.' }
      $minimumMatchValue = 0
      if (-not [int]::TryParse($minMatch.Text, [ref]$minimumMatchValue) -or $minimumMatchValue -lt 30 -or $minimumMatchValue -gt 95) { throw 'El encaje mínimo debe estar entre 30 y 95.' }
      $intervalValue = 0
      if (-not [int]::TryParse($interval.Text, [ref]$intervalValue) -or $intervalValue -lt 1 -or $intervalValue -gt 1440) { throw 'La frecuencia debe ser un número de 1 a 1440 minutos.' }
      $profileData = @{
        name = $name.Text.Trim(); email = $email.Text.Trim(); phone = [string]$p.phone; location = $location.Text.Trim();
        roles = $roles.Text.Trim(); mode = $mode.Text.Trim(); resume = $resume.Text.Trim(); summary = $summary.Text.Trim();
        experience = [string]$p.experience; skills = $skills.Text.Trim(); link = [string]$p.link;
        salaryExpectation = [string]$p.salaryExpectation; workAuthorization = [string]$p.workAuthorization;
        applicationAnswers = $p.applicationAnswers
      }
      $response = Invoke-PostulaApi '/api/configure' @{ profile = $profileData; minimumMatch = $minimumMatchValue; dailyLimit = $dailyLimitValue; intervalMinutes = $intervalValue }
      $dialog.Close()
      [System.Windows.MessageBox]::Show("Perfil guardado. El agente inició una búsqueda con $($response.minimumMatch)% de encaje y volverá a revisar cada $($response.intervalMinutes) minutos. El máximo de postulaciones es un ajuste separado.", 'Postula') | Out-Null
    } catch { $button.IsEnabled = $true; $button.Content = 'Guardar y buscar ahora'; [System.Windows.MessageBox]::Show("Revisá los campos obligatorios y volvé a intentar:`n$($_.Exception.Message)", 'Postula', 'OK', 'Warning') | Out-Null }
  }.GetNewClosure())
  [void]$dialog.ShowDialog()
}

function Get-StatusLabel([string]$status) {
  switch ($status) {
    'submitted' { 'Enviada y confirmada' }
    'submitted_unconfirmed' { 'Enviada · sin confirmación visible' }
    'ready_to_submit' { 'Lista para revisar' }
    'needs_attention' { 'Requiere tu atención' }
    'no_application_form' { 'Sin formulario compatible' }
    'excluded' { 'Excluida por vos' }
    'error' { 'Error' }
    default { $status }
  }
}

function Set-Pipeline([string]$stage, [string]$phase) {
  $normalized = "$stage $phase".ToLowerInvariant()
  $active = 1
  if ($normalized -match 'validar|encaje|abriendo publicaci|preparando cv|revisando ofertas') { $active = 2 }
  if ($normalized -match 'formulario|solicitud|captcha|verificaci[oó]n') { $active = 3 }
  if ($normalized -match 'confirmaci[oó]n|enviando|confirmada por el portal') { $active = 4 }
  $textSteps = @($window.FindName('Step1'), $window.FindName('Step2'), $window.FindName('Step3'), $window.FindName('Step4'))
  $indexSteps = @($window.FindName('Step1Index'), $window.FindName('Step2Index'), $window.FindName('Step3Index'), $window.FindName('Step4Index'))
  for ($i = 0; $i -lt 4; $i++) {
    $brush = if (($i + 1) -le $active) { $script:BlueBrush } else { $script:MutedBrush }
    $textSteps[$i].Foreground = $brush
    $indexSteps[$i].Foreground = $brush
  }
}

function Render-Recent($items) {
  $script:RecentHost.Children.Clear()
  $visibleItems = @($items | Select-Object -First 5)
  if ($visibleItems.Count -eq 0) {
    $empty = New-Object System.Windows.Controls.TextBlock
    $empty.Text = 'Todavía no se procesaron ofertas.'; $empty.FontSize = 13; $empty.Foreground = $script:MutedBrush; $empty.Margin = '0,9,0,9'
    [void]$script:RecentHost.Children.Add($empty); return
  }
  foreach ($item in $visibleItems) {
    $row = New-Object System.Windows.Controls.Grid
    $row.Margin = '0,7,0,7'
    [void]$row.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $statusColumn = New-Object System.Windows.Controls.ColumnDefinition; $statusColumn.Width = [System.Windows.GridLength]::Auto; [void]$row.ColumnDefinitions.Add($statusColumn)
    $openColumn = New-Object System.Windows.Controls.ColumnDefinition; $openColumn.Width = [System.Windows.GridLength]::Auto; [void]$row.ColumnDefinitions.Add($openColumn)
    $title = New-Object System.Windows.Controls.StackPanel
    $role = New-Object System.Windows.Controls.TextBlock; $role.Text = [string]$item.role; $role.FontSize = 13; $role.FontWeight = 'SemiBold'; $role.Foreground = $script:InkBrush; $role.TextTrimming = 'CharacterEllipsis'
    $company = New-Object System.Windows.Controls.TextBlock; $company.Text = "$($item.company) · $($item.source)"; $company.FontSize = 12; $company.Foreground = $script:MutedBrush; $company.Margin = '0,2,0,0'
    [void]$title.Children.Add($role); [void]$title.Children.Add($company)
    [void]$row.Children.Add($title)
    $badge = New-Object System.Windows.Controls.TextBlock; $badge.Text = Get-StatusLabel ([string]$item.status); $badge.FontSize = 11; $badge.Foreground = $script:MutedBrush; $badge.Margin = '14,3,0,0'; $badge.ToolTip = [string]$item.reason
    [System.Windows.Controls.Grid]::SetColumn($badge, 1); [void]$row.Children.Add($badge)
    $open = New-Object System.Windows.Controls.Button; $open.Content = 'Abrir aviso'; $open.FontSize = 11; $open.Padding = '8,3'; $open.Margin = '10,0,0,0'; $open.ToolTip = 'Abrir el aviso en el navegador solo cuando quieras revisarlo'
    $open.Add_Click({
      $jobUrl = [string]$item.url
      $parsedUrl = $null
      if ([Uri]::TryCreate($jobUrl, [UriKind]::Absolute, [ref]$parsedUrl) -and $parsedUrl.Scheme -in @('https', 'http')) { Start-Process $parsedUrl.AbsoluteUri }
    }.GetNewClosure())
    [System.Windows.Controls.Grid]::SetColumn($open, 2); [void]$row.Children.Add($open)
    $rule = New-Object System.Windows.Controls.Border; $rule.Height = 1; $rule.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#EEEBE8'); $rule.Margin = '0,0,0,0'
    $cell = New-Object System.Windows.Controls.StackPanel; [void]$cell.Children.Add($row); [void]$cell.Children.Add($rule)
    [void]$script:RecentHost.Children.Add($cell)
  }
}

function Render-Matches($items) {
  $script:MatchesHost.Children.Clear()
  $visible = @($items | Select-Object -First 8)
  if ($visible.Count -eq 0) {
    $empty = New-Object System.Windows.Controls.TextBlock
    $empty.Text = 'Sin resultados todavía. Configurá el CV y elegí “Guardar y buscar ahora”.'; $empty.FontSize = 13; $empty.Foreground = $script:MutedBrush; $empty.TextWrapping = 'Wrap'
    [void]$script:MatchesHost.Children.Add($empty); return
  }
  foreach ($entry in $visible) {
    $item = $entry
    $grid = New-Object System.Windows.Controls.Grid; $grid.Margin = '0,6,0,6'
    [void]$grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $actionColumn = New-Object System.Windows.Controls.ColumnDefinition; $actionColumn.Width = [System.Windows.GridLength]::Auto; [void]$grid.ColumnDefinitions.Add($actionColumn)
    $details = New-Object System.Windows.Controls.StackPanel
    $role = New-Object System.Windows.Controls.TextBlock; $role.Text = [string]$item.role; $role.FontSize = 13; $role.FontWeight = 'SemiBold'; $role.Foreground = $script:InkBrush; $role.TextWrapping = 'Wrap'
    $company = New-Object System.Windows.Controls.TextBlock; $company.Text = "$($item.company) · $($item.source)"; $company.FontSize = 11; $company.Foreground = $script:MutedBrush; $company.Margin = '0,2,0,0'
    $meta = New-Object System.Windows.Controls.TextBlock; $meta.Text = "$($item.location) · $($item.match)% encaje"; $meta.FontSize = 11; $meta.Foreground = $script:MutedBrush; $meta.Margin = '0,2,0,0'; $meta.TextWrapping = 'Wrap'
    [void]$details.Children.Add($role); [void]$details.Children.Add($company); [void]$details.Children.Add($meta); [void]$grid.Children.Add($details)
    $open = New-Object System.Windows.Controls.Button; $open.Content = 'Abrir oferta ↗'; $open.FontSize = 11; $open.Padding = '9,4'; $open.Margin = '10,0,0,0'; $open.VerticalAlignment = 'Center'
    $open.Add_Click({
      $targetUrl = [string]$item.url; $parsed = $null
      if ([Uri]::TryCreate($targetUrl, [UriKind]::Absolute, [ref]$parsed) -and $parsed.Scheme -in @('https', 'http')) { Start-Process $parsed.AbsoluteUri }
    }.GetNewClosure())
    [System.Windows.Controls.Grid]::SetColumn($open, 1); [void]$grid.Children.Add($open)
    $divider = New-Object System.Windows.Controls.Border; $divider.Height = 1; $divider.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#EEEBE8')
    $cell = New-Object System.Windows.Controls.StackPanel; [void]$cell.Children.Add($grid); [void]$cell.Children.Add($divider); [void]$script:MatchesHost.Children.Add($cell)
  }
}

function Render-Approvals($items) {
  $script:ApprovalHost.Children.Clear()
  if (@($items).Count -eq 0) {
    $empty = New-Object System.Windows.Controls.TextBlock
    $empty.Text = 'No hay formularios esperando confirmación.'; $empty.FontSize = 13; $empty.Foreground = $script:MutedBrush; $empty.TextWrapping = 'Wrap'
    [void]$script:ApprovalHost.Children.Add($empty); return
  }
  foreach ($item in $items) {
    $pendingItem = $item
    $card = New-Object System.Windows.Controls.StackPanel
    $role = New-Object System.Windows.Controls.TextBlock; $role.Text = [string]$pendingItem.role; $role.FontSize = 14; $role.FontWeight = 'SemiBold'; $role.Foreground = $script:InkBrush; $role.TextWrapping = 'Wrap'
    $company = New-Object System.Windows.Controls.TextBlock; $company.Text = "$($pendingItem.company) · $($pendingItem.source)"; $company.FontSize = 12; $company.Foreground = $script:MutedBrush; $company.Margin = '0,3,0,0'
    $match = New-Object System.Windows.Controls.TextBlock; $match.Text = "Encaje estimado: $($pendingItem.match)% · el formulario queda abierto en Chromium."; $match.FontSize = 12; $match.Foreground = $script:MutedBrush; $match.Margin = '0,10,0,12'; $match.TextWrapping = 'Wrap'
    $actions = New-Object System.Windows.Controls.StackPanel; $actions.Orientation = 'Horizontal'
    $review = New-Object System.Windows.Controls.Button; $review.Content = 'Ver formulario abierto'; $review.Margin = '0,0,8,0'; $review.Add_Click({ try { Invoke-PostulaApi '/api/focus' | Out-Null } catch { [System.Windows.MessageBox]::Show('El formulario ya no está abierto.', 'Postula') | Out-Null } }.GetNewClosure())
    $send = New-Object System.Windows.Controls.Button; $send.Content = 'Confirmar y enviar'; $send.Style = $window.FindResource('PrimaryButton')
    $send.Add_Click({
      $confirmationText = "Esto enviará tu CV y los datos de tu perfil a $($pendingItem.company) para el puesto $($pendingItem.role).`n`n¿Confirmás el envío?"
      $choice = [System.Windows.MessageBox]::Show($confirmationText, 'Confirmar postulación', 'YesNo', 'Warning')
      if ($choice -ne 'Yes') { return }
      $send.IsEnabled = $false
      try { Invoke-PostulaApi '/api/approve' @{ jobId = [string]$pendingItem.jobId } | Out-Null; $send.Content = 'Envío autorizado' }
      catch { $send.IsEnabled = $true; $send.Content = 'Confirmar y enviar'; [System.Windows.MessageBox]::Show($_.Exception.Message, 'Postula') | Out-Null }
    }.GetNewClosure())
    [void]$actions.Children.Add($review); [void]$actions.Children.Add($send)
    $note = New-Object System.Windows.Controls.TextBlock; $note.Text = "Al confirmar, Postula enviará esta candidatura a $($pendingItem.company)."; $note.FontSize = 12; $note.Foreground = $script:MutedBrush; $note.TextWrapping = 'Wrap'; $note.Margin = '0,9,0,0'
    [void]$card.Children.Add($role); [void]$card.Children.Add($company); [void]$card.Children.Add($match); [void]$card.Children.Add($actions); [void]$card.Children.Add($note)
    [void]$script:ApprovalHost.Children.Add($card)
  }
}

function Update-Window($data) {
  $script:LastData = $data
  $script:ConnectionDot.Fill = $script:GreenBrush
  $script:ConnectionLabel.Text = 'Agente conectado'
  $script:UpdatedLabel.Text = 'Actualizado ' + (Get-Date).ToString('HH:mm:ss')
  $status = $data.status
  $processed = 0
  if ($null -ne $data.totals.processed) { $processed = $data.totals.processed }
  $matched = 0
  if ($null -ne $status.matched) { $matched = $status.matched }
  $submitted = 0
  if ($null -ne $data.totals.submitted) { $submitted = $data.totals.submitted }
  $phase = [string]$status.phase
  if ([string]::IsNullOrWhiteSpace($phase)) { $phase = 'En espera' }
  $script:MetricProcessed.Text = [string]$processed
  $script:MetricMatched.Text = [string]$matched
  $script:MetricReady.Text = [string](@($data.pendingApprovals).Count)
  $script:MetricSubmitted.Text = [string]$submitted
  $script:PhaseLabel.Text = $phase
  $isWorking = $status.phase -match 'buscando|revisando|completando|enviando|esperando tu confirmaci[oó]n|verificaci[oó]n'
  $script:WorkLabel.Text = if ($isWorking) { 'Trabajando' } else { 'En espera' }
  $script:WorkLabel.Foreground = if ($isWorking) { $script:BlueBrush } else { $script:GreenBrush }
  $job = $status.currentJob
  if ($job) {
    $script:CurrentStage.Text = [string]$job.stage
    $script:CurrentRole.Text = [string]$job.role
    $script:CurrentCompany.Text = [string]$job.company
    $script:CurrentMatch.Text = if ($job.match) { "$($job.match)% de encaje" } else { '' }
  } else {
    $script:CurrentStage.Text = if ($phase -eq 'En espera') { 'Esperando actividad' } else { $phase }
    $script:CurrentRole.Text = if ($status.error) { [string]$status.error } else { 'No hay una oferta abierta en este momento.' }
    $script:CurrentCompany.Text = if ($status.nextRunAt) { 'Próxima búsqueda: ' + ([DateTime]::Parse($status.nextRunAt).ToLocalTime().ToString('HH:mm')) } else { '' }
    $script:CurrentMatch.Text = ''
  }
  Set-Pipeline ([string]$job.stage) ([string]$status.phase)
  Render-Matches $status.matches
  Render-Recent $data.recent
  Render-Approvals $data.pendingApprovals
  if ($script:AgentProcess -and $script:AgentProcess.HasExited) { $script:OwnsAgent = $false; $script:AgentProcess = $null }
  $script:AgentToggle.Content = 'Detener agente'
}

try { Start-PostulaAgent } catch {
  [System.Windows.MessageBox]::Show("No pude iniciar el agente:`n$($_.Exception.Message)", 'Postula', 'OK', 'Error') | Out-Null
}

$toggleClick = {
  if (Test-AgentApi) {
    try { Invoke-PostulaApi '/api/stop' | Out-Null } catch {}
    $script:AgentToggle.IsEnabled = $false
    $script:AgentToggle.Content = 'Deteniendo…'
    if ($script:OwnsAgent) { $script:OwnsAgent = $false }
  } else {
    try { Start-PostulaAgent; $script:AgentToggle.Content = 'Iniciando…' } catch { [System.Windows.MessageBox]::Show($_.Exception.Message, 'Postula') | Out-Null }
  }
}.GetNewClosure()
$script:AgentToggle.Add_Click($toggleClick)
$script:ConfigureButton.Add_Click({ Show-ProfileDialog })

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({
  try {
    $data = Invoke-RestMethod -Uri "$($script:ApiBase)/api/status" -TimeoutSec 2
    Update-Window $data
    $script:AgentToggle.IsEnabled = $true
  } catch {
    $script:ConnectionDot.Fill = $script:GrayBrush
    $script:ConnectionLabel.Text = 'Agente desconectado'
    $script:UpdatedLabel.Text = 'La ventana sigue abierta'
    $script:PhaseLabel.Text = 'Agente detenido'
    $script:WorkLabel.Text = 'En espera'
    $script:CurrentStage.Text = 'Inactivo'
    $script:CurrentRole.Text = 'Iniciá el agente para volver a buscar.'
    $script:CurrentCompany.Text = ''
    $script:CurrentMatch.Text = ''
    $script:MetricReady.Text = '0'
    $script:AgentToggle.Content = 'Iniciar agente'
    $script:AgentToggle.IsEnabled = $true
  }
})
$window.Add_Closed({
  $timer.Stop()
  if ($script:OwnsAgent -and $script:AgentProcess -and -not $script:AgentProcess.HasExited) {
    try { Invoke-PostulaApi '/api/stop' | Out-Null } catch {}
    for ($i = 0; $i -lt 20 -and -not $script:AgentProcess.HasExited; $i++) { Start-Sleep -Milliseconds 250 }
    if (-not $script:AgentProcess.HasExited) { Stop-Process -Id $script:AgentProcess.Id -Force -ErrorAction SilentlyContinue }
  }
})
$timer.Start()
[void]$window.ShowDialog()
