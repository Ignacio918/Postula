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
        Title="Postula · Agente" Height="900" Width="1440" MinHeight="700" MinWidth="1080"
        WindowStartupLocation="CenterScreen" Background="#111111" Foreground="#F1F2F3" FontFamily="Segoe UI">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Foreground" Value="#E8EAEC"/><Setter Property="Background" Value="#202326"/>
      <Setter Property="BorderBrush" Value="#34383B"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="12,8"/><Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="buttonBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="buttonBorder" Property="Background" Value="#2A2E31"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="buttonBorder" Property="Opacity" Value="0.5"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="PrimaryButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Foreground" Value="#111111"/><Setter Property="Background" Value="#F1F2F3"/><Setter Property="BorderBrush" Value="#F1F2F3"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Height" Value="36"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="primaryBorder" Background="{TemplateBinding Background}" CornerRadius="18" Padding="{TemplateBinding Padding}">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="primaryBorder" Property="Opacity" Value="0.88"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="primaryBorder" Property="Opacity" Value="0.5"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="ComboBoxItem">
      <Setter Property="Foreground" Value="#E8EAEC"/><Setter Property="Background" Value="#181818"/><Setter Property="Padding" Value="9,6"/><Setter Property="HorizontalContentAlignment" Value="Stretch"/><Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ComboBoxItem">
        <Border x:Name="itemBorder" Background="{TemplateBinding Background}" Padding="{TemplateBinding Padding}" CornerRadius="4" SnapsToDevicePixels="True">
          <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsHighlighted" Value="True"><Setter TargetName="itemBorder" Property="Background" Value="#292929"/></Trigger>
          <Trigger Property="IsSelected" Value="True"><Setter TargetName="itemBorder" Property="Background" Value="#292929"/><Setter Property="Foreground" Value="#FFFFFF"/></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="itemBorder" Property="Opacity" Value="0.5"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="ComboBox">
      <Setter Property="Foreground" Value="#E8EAEC"/><Setter Property="Background" Value="#202020"/><Setter Property="BorderBrush" Value="#343434"/><Setter Property="BorderThickness" Value="1"/><Setter Property="Padding" Value="8,4"/><Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ComboBox">
        <Grid>
          <ToggleButton x:Name="Toggle" Focusable="False" ClickMode="Press" IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}" Background="{TemplateBinding Background}" Foreground="{TemplateBinding Foreground}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}" Content="{TemplateBinding SelectionBoxItem}" ContentTemplate="{TemplateBinding SelectionBoxItemTemplate}" ContentStringFormat="{TemplateBinding SelectionBoxItemStringFormat}">
            <ToggleButton.Template><ControlTemplate TargetType="ToggleButton">
              <Border x:Name="toggleBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="6" Padding="{TemplateBinding Padding}">
                <Grid><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><ContentPresenter Content="{TemplateBinding Content}" ContentTemplate="{TemplateBinding ContentTemplate}" ContentStringFormat="{TemplateBinding ContentStringFormat}" VerticalAlignment="Center" HorizontalAlignment="Left"/><Path Grid.Column="1" Data="M 0 0 L 4 4 L 8 0 Z" Fill="#A0A4A8" Width="8" Height="4" Stretch="Fill" VerticalAlignment="Center" Margin="8,0,2,0"/></Grid>
              </Border>
              <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="toggleBorder" Property="Background" Value="#292929"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter TargetName="toggleBorder" Property="Opacity" Value="0.5"/></Trigger></ControlTemplate.Triggers>
            </ControlTemplate></ToggleButton.Template>
          </ToggleButton>
          <Popup x:Name="Popup" Placement="Bottom" AllowsTransparency="True" Focusable="False" IsOpen="{TemplateBinding IsDropDownOpen}" PopupAnimation="Fade">
            <Border Background="#181818" BorderBrush="#343434" BorderThickness="1" CornerRadius="6" MinWidth="{Binding ActualWidth, RelativeSource={RelativeSource TemplatedParent}}">
              <ScrollViewer CanContentScroll="True" SnapsToDevicePixels="True"><ItemsPresenter/></ScrollViewer>
            </Border>
          </Popup>
        </Grid>
        <ControlTemplate.Triggers><Trigger Property="HasItems" Value="False"><Setter TargetName="Popup" Property="MinHeight" Value="24"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.55"/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="NavButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="HorizontalContentAlignment" Value="Left"/><Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderBrush" Value="Transparent"/><Setter Property="Padding" Value="12,9"/>
      <Setter Property="FontWeight" Value="Normal"/>
    </Style>
  </Window.Resources>
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width="58"/><ColumnDefinition Width="270"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <Border Grid.Column="0" Background="#0B0B0B" BorderBrush="#292929" BorderThickness="0,0,1,0">
      <DockPanel LastChildFill="False">
        <Border DockPanel.Dock="Top" Width="34" Height="34" CornerRadius="8" Background="#202326" Margin="11,14,11,24" ToolTip="Postula">
          <Image x:Name="BrandIcon" Width="25" Height="25"/>
        </Border>
        <StackPanel DockPanel.Dock="Top">
          <Button x:Name="NavActivity" Content="◉" ToolTip="Actividad del agente" Style="{StaticResource NavButton}" HorizontalContentAlignment="Center" Padding="0,10" Margin="7,0,7,6" Background="#252525" Foreground="#F1F2F3"/>
          <Button x:Name="NavOffers" Content="⌕" ToolTip="Ofertas que coinciden" Style="{StaticResource NavButton}" HorizontalContentAlignment="Center" Padding="0,10" Margin="7,0,7,6"/>
          <Button x:Name="NavApplications" Content="✓" ToolTip="Postulaciones y revisiones" Style="{StaticResource NavButton}" HorizontalContentAlignment="Center" Padding="0,10" Margin="7,0,7,6"/>
        </StackPanel>
        <StackPanel DockPanel.Dock="Bottom" Margin="7,0,7,14">
          <Button x:Name="NavProfile" Content="⚙" ToolTip="Configurar CV y búsqueda" Style="{StaticResource NavButton}" HorizontalContentAlignment="Center" Padding="0,10"/>
          <TextBlock Text="LOCAL" FontSize="9" Foreground="#777D82" HorizontalAlignment="Center" Margin="0,10,0,0" ToolTip="Tus datos permanecen en esta computadora"/>
        </StackPanel>
      </DockPanel>
    </Border>
    <Border Grid.Column="1" Background="#121212" BorderBrush="#292929" BorderThickness="0,0,1,0">
      <DockPanel Margin="14,18,14,14">
        <StackPanel DockPanel.Dock="Top">
          <StackPanel Orientation="Horizontal" Margin="2,0,0,17">
            <TextBlock Text="postula" FontSize="18" FontWeight="Bold" Foreground="#F1F2F3"/>
            <TextBlock Text="." FontSize="18" FontWeight="Bold" Foreground="#63C5A3" Margin="-5,0,0,0"/>
          </StackPanel>
          <TextBlock Text="TU ESPACIO" FontSize="10" Foreground="#8D9296" Margin="3,0,0,8"/>
          <Grid Height="36"><TextBox x:Name="SearchBox" Padding="10,7" FontSize="12" Background="#202326" Foreground="#E8EAEC" BorderBrush="#34383B" CaretBrush="#63C5A3" ToolTip="Filtrar ofertas por puesto o empresa" Text=""/><TextBlock x:Name="SearchPlaceholder" Text="⌕  Filtrar ofertas" Foreground="#858A8E" FontSize="12" Margin="11,0,0,0" VerticalAlignment="Center" IsHitTestVisible="False"/></Grid>
          <TextBlock Text="BÚSQUEDA" FontSize="10" Foreground="#8D9296" Margin="3,22,0,8"/>
          <Border Background="#1C1C1C" BorderBrush="#343434" BorderThickness="1" CornerRadius="7" Padding="10,11" Margin="0,0,0,8">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="30"/><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <Border Width="25" Height="25" CornerRadius="6" Background="#303638" VerticalAlignment="Top"><TextBlock Text="P" Foreground="#63C5A3" FontWeight="Bold" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1"><TextBlock Text="Empleo" FontSize="13" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock x:Name="SidebarPhase" Text="Leyendo estado…" FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0" TextTrimming="CharacterEllipsis"/></StackPanel>
              <Ellipse x:Name="SidebarDot" Grid.Column="2" Width="7" Height="7" Fill="#777D82" Margin="8,4,0,0" VerticalAlignment="Top"/>
            </Grid>
          </Border>
          <Button x:Name="SidebarActivityNav" Content="Actividad del agente" Style="{StaticResource NavButton}" Margin="0,4,0,0"/>
          <Button x:Name="SidebarOffersNav" Content="Ofertas encontradas" Style="{StaticResource NavButton}"/>
          <Button x:Name="SidebarApplicationsNav" Content="Postulaciones" Style="{StaticResource NavButton}"/>
        </StackPanel>
        <StackPanel DockPanel.Dock="Bottom">
          <Border Height="1" Background="#2B2E31" Margin="0,0,0,12"/>
          <Button x:Name="SidebarProfileNav" Content="Perfil · CV y preferencias" Style="{StaticResource NavButton}"/>
          <TextBlock Text="La búsqueda corre en esta PC" FontSize="10" Foreground="#8D9296" Margin="12,4,0,2"/>
        </StackPanel>
      </DockPanel>
    </Border>
    <DockPanel Grid.Column="2" LastChildFill="True">
      <Border DockPanel.Dock="Top" Height="64" Background="#111111" BorderBrush="#292929" BorderThickness="0,0,0,1">
        <Grid Margin="24,0"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center"><TextBlock Text="postula" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock Text=" · LOCAL" FontSize="10" Foreground="#929292" VerticalAlignment="Center" Margin="8,0,0,0"/><Border Width="1" Height="18" Background="#343434" Margin="14,0"/><Ellipse x:Name="ConnectionDot" Width="7" Height="7" Fill="#777D82" Margin="0,0,8,0"/><TextBlock x:Name="ConnectionLabel" Text="Conectando…" FontSize="12" Foreground="#C5C5C5" VerticalAlignment="Center"/></StackPanel>
          <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center"><Button x:Name="SearchNowButton" Content="Buscar ofertas" Style="{StaticResource PrimaryButton}" Padding="15,0" Margin="0,0,9,0"/><Button x:Name="ConfigureButton" Content="Configurar perfil" Margin="0,0,9,0"/><Button x:Name="AgentToggle" Content="Detener agente" MinWidth="112"/></StackPanel>
        </Grid>
      </Border>
      <ScrollViewer x:Name="MainScroll" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Background="#111111">
        <Grid x:Name="WorkspaceViews" Margin="28,22,28,28">
        <StackPanel x:Name="OverviewView">
        <Grid Margin="0,0,0,18"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel><TextBlock Text="Tu búsqueda" FontSize="24" FontWeight="SemiBold" Foreground="#F1F2F3"/><StackPanel Orientation="Horizontal" Margin="0,5,0,0"><Ellipse Width="7" Height="7" Fill="#63C5A3" Margin="0,0,8,0"/><TextBlock x:Name="PhaseLabelTop" Text="Agente listo para buscar" FontSize="12" Foreground="#A0A4A8"/></StackPanel></StackPanel>
          <TextBlock x:Name="UpdatedLabel" Grid.Column="1" Text="Esperando datos" FontSize="11" Foreground="#777D82" VerticalAlignment="Bottom"/>
        </Grid>
        <Border Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Margin="0,0,0,14">
          <Grid Height="58"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/></Grid.ColumnDefinitions>
            <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step1Index" Text="1" FontSize="11" Foreground="#63C5A3" Margin="0,0,8,0"/><TextBlock x:Name="Step1" Text="Buscar ofertas" FontSize="12" Foreground="#F1F2F3"/></StackPanel><Border Grid.Column="1" Background="#2B2E31"/>
            <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step2Index" Text="2" FontSize="11" Foreground="#858A8E" Margin="0,0,8,0"/><TextBlock x:Name="Step2" Text="Validar encaje" FontSize="12" Foreground="#A0A4A8"/></StackPanel><Border Grid.Column="3" Background="#2B2E31"/>
            <StackPanel Grid.Column="4" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step3Index" Text="3" FontSize="11" Foreground="#858A8E" Margin="0,0,8,0"/><TextBlock x:Name="Step3" Text="Completar solicitud" FontSize="12" Foreground="#A0A4A8"/></StackPanel><Border Grid.Column="5" Background="#2B2E31"/>
            <StackPanel Grid.Column="6" Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Center"><TextBlock x:Name="Step4Index" Text="4" FontSize="11" Foreground="#858A8E" Margin="0,0,8,0"/><TextBlock x:Name="Step4" Text="Confirmar y enviar" FontSize="12" Foreground="#A0A4A8"/></StackPanel>
          </Grid>
        </Border>
        <Border Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Margin="0,0,0,21">
          <Grid><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/><ColumnDefinition Width="1"/><ColumnDefinition/></Grid.ColumnDefinitions>
            <StackPanel Grid.Column="0" Margin="16,12"><TextBlock Text="Avisos revisados" FontSize="12" Foreground="#A0A4A8"/><TextBlock x:Name="MetricProcessed" Text="0" FontSize="25" Foreground="#F1F2F3" Margin="0,2,0,0"/><TextBlock Text="abiertos por el agente" FontSize="11" Foreground="#858A8E" Margin="0,1,0,0"/></StackPanel><Border Grid.Column="1" Background="#2B2E31"/>
            <StackPanel Grid.Column="2" Margin="16,12"><TextBlock Text="Compatibles" FontSize="12" Foreground="#A0A4A8"/><TextBlock x:Name="MetricMatched" Text="0" FontSize="25" Foreground="#F1F2F3" Margin="0,2,0,0"/><TextBlock Text="en las ofertas actuales" FontSize="11" Foreground="#858A8E" Margin="0,1,0,0"/></StackPanel><Border Grid.Column="3" Background="#2B2E31"/>
            <StackPanel Grid.Column="4" Margin="16,12"><TextBlock Text="Listas para revisar" FontSize="12" Foreground="#A0A4A8"/><TextBlock x:Name="MetricReady" Text="0" FontSize="25" Foreground="#F1F2F3" Margin="0,2,0,0"/><TextBlock Text="requieren confirmación" FontSize="11" Foreground="#858A8E" Margin="0,1,0,0"/></StackPanel><Border Grid.Column="5" Background="#2B2E31"/>
            <StackPanel Grid.Column="6" Margin="16,12"><TextBlock Text="Confirmadas" FontSize="12" Foreground="#A0A4A8"/><TextBlock x:Name="MetricSubmitted" Text="0" FontSize="25" Foreground="#F1F2F3" Margin="0,2,0,0"/><TextBlock Text="por el portal" FontSize="11" Foreground="#858A8E" Margin="0,1,0,0"/></StackPanel>
          </Grid>
        </Border>
        <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="1.8*"/><ColumnDefinition Width="18"/><ColumnDefinition Width="1*"/></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0">
            <Border x:Name="MatchesCard" Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Margin="0,0,0,16">
              <StackPanel><Grid Margin="16,14,16,10"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="Ofertas encontradas" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock x:Name="MatchesCountLabel" Text="Cargando historial…" FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0"/></StackPanel><ComboBox x:Name="OffersFilter" Grid.Column="1" Width="142" Height="30" FontSize="11" Padding="6,3" VerticalAlignment="Center" Background="#202326" Foreground="#E8EAEC" BorderBrush="#34383B"><ComboBoxItem Content="Todas"/><ComboBoxItem Content="Compatibles"/><ComboBoxItem Content="Requieren atención"/><ComboBoxItem Content="Enviadas"/></ComboBox></Grid><Border Height="1" Background="#2B2E31" Margin="16,0"/><StackPanel Margin="16,10,16,15"><StackPanel x:Name="MatchesHost"><TextBlock Text="Tocá Buscar ofertas para iniciar el primer ciclo." FontSize="12" Foreground="#A0A4A8" TextWrapping="Wrap"/></StackPanel><Button x:Name="ShowMoreOffers" Content="Mostrar más ofertas" Visibility="Collapsed" HorizontalAlignment="Stretch" Margin="0,10,0,0"/></StackPanel></StackPanel>
            </Border>
            <Border x:Name="ApprovalCard" Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Margin="0,0,0,16">
              <StackPanel><StackPanel Margin="16,14,16,10"><TextBlock Text="Listas para enviar" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock Text="Cada envío espera tu confirmación." FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0" TextWrapping="Wrap"/></StackPanel><Border Height="1" Background="#2B2E31" Margin="16,0"/><StackPanel x:Name="ApprovalHost" Margin="16,10,16,15"><TextBlock Text="No hay formularios esperando confirmación." FontSize="12" Foreground="#A0A4A8" TextWrapping="Wrap"/></StackPanel></StackPanel>
            </Border>
          </StackPanel>
          <StackPanel Grid.Column="2">
            <Border x:Name="CurrentCard" Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Margin="0,0,0,16">
              <StackPanel><Grid Margin="16,14,16,11"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="Ahora" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock x:Name="PhaseLabel" Text="Leyendo el estado del agente" FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0"/></StackPanel><TextBlock x:Name="WorkLabel" Grid.Column="1" Text="En espera" FontSize="11" Foreground="#63C5A3" VerticalAlignment="Center"/></Grid><Border Height="1" Background="#2B2E31" Margin="16,0"/><StackPanel Margin="16,12,16,15"><TextBlock x:Name="CurrentStage" Text="Esperando actividad" FontSize="13" FontWeight="SemiBold" Foreground="#F1F2F3"/><Grid Margin="0,9,0,0"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock x:Name="CurrentRole" Text="Todavía no hay una oferta en revisión." FontSize="13" Foreground="#E4E6E8" TextWrapping="Wrap"/><TextBlock x:Name="CurrentCompany" Text="" FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0"/></StackPanel><TextBlock x:Name="CurrentMatch" Grid.Column="1" Text="" FontSize="11" Foreground="#63C5A3" VerticalAlignment="Top" Margin="14,0,0,0"/></Grid></StackPanel></StackPanel>
            </Border>
            <Border x:Name="RecentCard" Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8">
              <StackPanel><StackPanel Margin="16,14,16,10"><TextBlock Text="Actividad reciente" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock Text="Qué pasó con cada oferta" FontSize="11" Foreground="#A0A4A8" Margin="0,3,0,0"/></StackPanel><Border Height="1" Background="#2B2E31" Margin="16,0"/><StackPanel x:Name="RecentHost" Margin="16,4,16,8"><TextBlock Text="Todavía no se procesaron ofertas." FontSize="12" Foreground="#A0A4A8" Margin="0,10"/></StackPanel></StackPanel>
            </Border>
            <Border Background="#181818" BorderBrush="#181818" BorderThickness="0" CornerRadius="8" Padding="16">
              <StackPanel><TextBlock Text="Estado del ciclo" FontSize="14" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock x:Name="DiagnosticsLabel" Text="Las búsquedas usan fuentes públicas. Los portales con CAPTCHA o preguntas desconocidas requieren revisión manual." FontSize="11" Foreground="#A0A4A8" Margin="0,5,0,0" TextWrapping="Wrap"/></StackPanel>
            </Border>
          </StackPanel>
        </Grid>
        <TextBlock Text="Postula · agente local · tu CV y perfil permanecen en esta computadora" FontSize="10" Foreground="#858A8E" Margin="1,16,0,0" HorizontalAlignment="Center"/>
        </StackPanel>
        <StackPanel x:Name="ApplicationsView" Visibility="Collapsed" Width="840" HorizontalAlignment="Center">
          <Grid Margin="0,12,0,24"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="Postulaciones" FontSize="26" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock Text="Seguimiento de solicitudes que el portal recibió o confirmó." FontSize="13" Foreground="#A0A4A8" Margin="0,5,0,0"/></StackPanel><Button x:Name="ApplicationsSearchButton" Grid.Column="1" Content="Ir a ofertas" Style="{StaticResource PrimaryButton}" Padding="16,0" VerticalAlignment="Center"/></Grid>
          <Border Background="#181818" CornerRadius="12" Padding="22">
            <StackPanel><Grid Margin="0,0,0,14"><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><StackPanel><TextBlock Text="Historial de candidaturas" FontSize="15" FontWeight="SemiBold" Foreground="#F1F2F3"/><TextBlock x:Name="ApplicationsCount" Text="Cargando…" FontSize="11" Foreground="#A0A4A8" Margin="0,4,0,0"/></StackPanel><TextBlock Text="PORTAL" Grid.Column="1" FontSize="9" Foreground="#777D82" VerticalAlignment="Center"/></Grid><Border Height="1" Background="#2B2E31"/><StackPanel x:Name="ApplicationsEmpty" Margin="0,18,0,4"><TextBlock Text="Todavía no hay postulaciones enviadas" FontSize="16" FontWeight="SemiBold" Foreground="#F1F2F3" HorizontalAlignment="Center" Margin="0,12,0,0"/><TextBlock Text="Las ofertas que requieren tu confirmación aparecen en la pantalla de actividad. Postula solo cuenta como enviada una solicitud cuando el portal confirma el envío." FontSize="12" Foreground="#A0A4A8" TextWrapping="Wrap" TextAlignment="Center" HorizontalAlignment="Center" MaxWidth="510" Margin="0,8,0,16"/><TextBlock Text="Revisá el estado del agente y buscá más ofertas para empezar." FontSize="11" Foreground="#777D82" HorizontalAlignment="Center" Margin="0,0,0,12"/></StackPanel><StackPanel x:Name="ApplicationsHost" Margin="0,4,0,0"/></StackPanel>
          </Border>
          <TextBlock Text="El historial se guarda localmente en esta computadora." FontSize="10" Foreground="#777D82" HorizontalAlignment="Center" Margin="0,16,0,0"/>
        </StackPanel>
       </Grid>
      </ScrollViewer>
    </DockPanel>
  </Grid>
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
$script:OverviewView = $window.FindName('OverviewView')
$script:ApplicationsView = $window.FindName('ApplicationsView')
$script:ApplicationsCount = $window.FindName('ApplicationsCount')
$script:ApplicationsEmpty = $window.FindName('ApplicationsEmpty')
$script:ApplicationsHost = $window.FindName('ApplicationsHost')
$script:ApplicationsSearchButton = $window.FindName('ApplicationsSearchButton')
$script:MainScroll = $window.FindName('MainScroll')
$script:NavActivityButton = $window.FindName('NavActivity')
$script:NavOffersButton = $window.FindName('NavOffers')
$script:NavApplicationsButton = $window.FindName('NavApplications')
$script:PhaseLabelTop = $window.FindName('PhaseLabelTop')
$script:DiagnosticsLabel = $window.FindName('DiagnosticsLabel')
$script:ConfigureButton = $window.FindName('ConfigureButton')
$script:SearchNowButton = $window.FindName('SearchNowButton')
$script:AgentToggle = $window.FindName('AgentToggle')
$script:SearchBox = $window.FindName('SearchBox')
$script:OffersFilter = $window.FindName('OffersFilter')
$script:OffersFilter.SelectedIndex = 0
$script:MatchesCountLabel = $window.FindName('MatchesCountLabel')
$script:ShowMoreOffers = $window.FindName('ShowMoreOffers')
$script:DisplayedOfferCount = 20
$script:LastOffers = @()
$script:SidebarDot = $window.FindName('SidebarDot')
$script:SidebarPhase = $window.FindName('SidebarPhase')
$script:LastMatches = @()
$script:Steps = @(
  $window.FindName('Step1'), $window.FindName('Step2'), $window.FindName('Step3'), $window.FindName('Step4'),
  $window.FindName('Step1Index'), $window.FindName('Step2Index'), $window.FindName('Step3Index'), $window.FindName('Step4Index')
)
$script:InkBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F1F2F3')
$script:MutedBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#A0A4A8')
$script:BlueBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#63C5A3')
$script:GreenBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#63C5A3')
$script:GrayBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#777D82')
$script:SearchPlaceholder = $window.FindName('SearchPlaceholder')

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
  $inputBox.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#202326')
  $inputBox.Foreground = $script:InkBrush; $inputBox.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#34383B')
  $inputBox.CaretBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#63C5A3')
  if ($Height -gt 50) { $inputBox.AcceptsReturn = $true; $inputBox.TextWrapping = 'Wrap'; $inputBox.VerticalScrollBarVisibility = 'Auto'; $inputBox.VerticalContentAlignment = 'Top' }
  [void]$Panel.Children.Add($inputBox)
  return $inputBox
}

function Show-ProfileDialog {
  try { $saved = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json; $p = $saved.profile } catch { $saved = [pscustomobject]@{}; $p = [pscustomobject]@{} }
  $dialog = New-Object System.Windows.Window
  $dialog.Title = 'Configurá tu perfil y búsqueda · Postula'; $dialog.Width = 780; $dialog.Height = 860; $dialog.MinWidth = 680; $dialog.MinHeight = 700
  $dialog.WindowStartupLocation = 'CenterOwner'; $dialog.Owner = $window; $dialog.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#111315')
  $dialog.Resources = $window.Resources
  $outer = New-Object System.Windows.Controls.DockPanel; $dialog.Content = $outer
  $actions = New-Object System.Windows.Controls.StackPanel; $actions.Orientation = 'Horizontal'; $actions.HorizontalAlignment = 'Right'; $actions.Margin = '22,12,22,16'
  [System.Windows.Controls.DockPanel]::SetDock($actions, 'Bottom'); [void]$outer.Children.Add($actions)
  $cancel = New-Object System.Windows.Controls.Button; $cancel.Content = 'Cancelar'; $cancel.Margin = '0,0,9,0'; $cancel.Add_Click({ $dialog.Close() }.GetNewClosure()); [void]$actions.Children.Add($cancel)
  $save = New-Object System.Windows.Controls.Button; $save.Content = 'Guardar y buscar ahora'; $save.Style = $window.FindResource('PrimaryButton'); [void]$actions.Children.Add($save)
  $scroll = New-Object System.Windows.Controls.ScrollViewer; $scroll.VerticalScrollBarVisibility = 'Auto'; [void]$outer.Children.Add($scroll)
  $form = New-Object System.Windows.Controls.StackPanel; $form.Margin = '25,22,25,12'; $scroll.Content = $form
  $heading = New-Object System.Windows.Controls.TextBlock; $heading.Text = 'Prepará tu búsqueda'; $heading.FontSize = 23; $heading.FontWeight = 'SemiBold'; $heading.Foreground = $script:InkBrush; [void]$form.Children.Add($heading)
  $intro = New-Object System.Windows.Controls.TextBlock; $intro.Text = 'Cargá el CV y elegí qué querés buscar. Postula extrae el texto y calcula el encaje en esta computadora, sin mandar tu CV a una IA.'; $intro.FontSize = 13; $intro.Foreground = $script:MutedBrush; $intro.TextWrapping = 'Wrap'; $intro.Margin = '0,5,0,8'; [void]$form.Children.Add($intro)
  $cardBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#181A1C')
  $cardBorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#303438')
  $identityCard = New-Object System.Windows.Controls.Border; $identityCard.Background = $cardBrush; $identityCard.BorderBrush = $cardBorderBrush; $identityCard.BorderThickness = '1'; $identityCard.CornerRadius = '8'; $identityCard.Padding = '16'; $identityCard.Margin = '0,14,0,0'; [void]$form.Children.Add($identityCard)
  $identityPanel = New-Object System.Windows.Controls.StackPanel; $identityCard.Child = $identityPanel
  $identityHeading = New-Object System.Windows.Controls.TextBlock; $identityHeading.Text = 'Tu perfil'; $identityHeading.FontSize = 16; $identityHeading.FontWeight = 'SemiBold'; $identityHeading.Foreground = $script:InkBrush; [void]$identityPanel.Children.Add($identityHeading)
  $name = Add-ProfileField $identityPanel 'Nombre y apellido' ([string]$p.name)
  $email = Add-ProfileField $identityPanel 'Email' ([string]$p.email)
  $phone = Add-ProfileField $identityPanel 'Teléfono' ([string]$p.phone)
  $roles = Add-ProfileField $identityPanel 'Puestos (separados por coma)' ([string]$p.roles)
  $location = Add-ProfileField $identityPanel 'Ubicación' ($(if ($p.location) { [string]$p.location } else { 'Buenos Aires, Argentina' }))
  $currentCompany = Add-ProfileField $identityPanel 'Empresa actual (dejalo vacío si hoy no trabajás)' ([string]$p.currentCompany)
  $linkedin = Add-ProfileField $identityPanel 'LinkedIn (opcional)' ([string]$p.linkedin)
  $portfolio = Add-ProfileField $identityPanel 'Portfolio o sitio web (opcional)' ([string]$(if ($p.portfolio) { $p.portfolio } else { $p.link }))
  $salary = Add-ProfileField $identityPanel 'Expectativa salarial anual' ([string]$p.salaryExpectation)
  $authorization = Add-ProfileField $identityPanel 'Permiso de trabajo y sponsorship' ([string]$p.workAuthorization) 58
  $preferencesCard = New-Object System.Windows.Controls.Border; $preferencesCard.Background = $cardBrush; $preferencesCard.BorderBrush = $cardBorderBrush; $preferencesCard.BorderThickness = '1'; $preferencesCard.CornerRadius = '8'; $preferencesCard.Padding = '16'; $preferencesCard.Margin = '0,12,0,0'; [void]$form.Children.Add($preferencesCard)
  $preferencesPanel = New-Object System.Windows.Controls.StackPanel; $preferencesCard.Child = $preferencesPanel
  $preferencesHeading = New-Object System.Windows.Controls.TextBlock; $preferencesHeading.Text = 'Preferencias de búsqueda'; $preferencesHeading.FontSize = 16; $preferencesHeading.FontWeight = 'SemiBold'; $preferencesHeading.Foreground = $script:InkBrush; [void]$preferencesPanel.Children.Add($preferencesHeading)
  $modeCaption = New-Object System.Windows.Controls.TextBlock; $modeCaption.Text = 'Modalidad'; $modeCaption.FontSize = 12; $modeCaption.Foreground = $script:MutedBrush; $modeCaption.Margin = '0,10,0,5'; [void]$preferencesPanel.Children.Add($modeCaption)
  $mode = New-Object System.Windows.Controls.ComboBox; $mode.Height = 40; $mode.FontSize = 13; $mode.Padding = '10,6'; $mode.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#222629'); $mode.Foreground = $script:InkBrush; $mode.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#454A4D'); [void]$mode.Items.Add('Remoto'); [void]$mode.Items.Add('Híbrido'); [void]$mode.Items.Add('Presencial'); [void]$mode.Items.Add('Indistinto (todos)')
  $savedMode = ([string]$p.mode).ToLowerInvariant()
  if ($savedMode -match 'h[ií]brido|hybrid') { $mode.SelectedIndex = 1 } elseif ($savedMode -match 'presencial|onsite|on-site') { $mode.SelectedIndex = 2 } elseif ($savedMode -match 'indistinto|todos|all') { $mode.SelectedIndex = 3 } else { $mode.SelectedIndex = 0 }
  [void]$preferencesPanel.Children.Add($mode)
  $regionCaption = New-Object System.Windows.Controls.TextBlock; $regionCaption.Text = 'Prioridad geográfica'; $regionCaption.FontSize = 12; $regionCaption.Foreground = $script:MutedBrush; $regionCaption.Margin = '0,12,0,5'; [void]$preferencesPanel.Children.Add($regionCaption)
  $region = New-Object System.Windows.Controls.ComboBox; $region.Height = 40; $region.FontSize = 13; $region.Padding = '10,6'; $region.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#222629'); $region.Foreground = $script:InkBrush; $region.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#454A4D'); [void]$region.Items.Add('Argentina → LATAM → remoto global'); [void]$region.Items.Add('Solo Argentina y LATAM'); [void]$region.Items.Add('Sin prioridad geográfica')
  $region.SelectedIndex = switch ([string]$p.regionPreference) { 'regional-only' { 1 } 'balanced' { 2 } default { 0 } }; [void]$preferencesPanel.Children.Add($region)
  $regionNote = New-Object System.Windows.Controls.TextBlock; $regionNote.Text = 'Argentina y LATAM primero. Las vacantes que solo dicen Remote quedan marcadas con alcance a confirmar; las ciudades o países restringidos se excluyen.'; $regionNote.FontSize = 11; $regionNote.Foreground = $script:MutedBrush; $regionNote.Margin = '0,5,0,0'; $regionNote.TextWrapping = 'Wrap'; [void]$preferencesPanel.Children.Add($regionNote)
  $languageCaption = New-Object System.Windows.Controls.TextBlock; $languageCaption.Text = 'Idioma de la oferta'; $languageCaption.FontSize = 12; $languageCaption.Foreground = $script:MutedBrush; $languageCaption.Margin = '0,12,0,5'; [void]$preferencesPanel.Children.Add($languageCaption)
  $language = New-Object System.Windows.Controls.ComboBox; $language.Height = 40; $language.FontSize = 13; $language.Padding = '10,6'; $language.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#222629'); $language.Foreground = $script:InkBrush; $language.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#454A4D'); [void]$language.Items.Add('Priorizar español'); [void]$language.Items.Add('Español únicamente'); [void]$language.Items.Add('Sin preferencia'); $language.SelectedIndex = switch ([string]$p.languagePreference) { 'spanish-only' { 1 } 'any' { 2 } default { 0 } }; [void]$preferencesPanel.Children.Add($language)
  $languageNote = New-Object System.Windows.Controls.TextBlock; $languageNote.Text = 'Primero aparecen vacantes publicadas o que solicitan español. El idioma se estima por el texto disponible.'; $languageNote.FontSize = 11; $languageNote.Foreground = $script:MutedBrush; $languageNote.Margin = '0,5,0,0'; $languageNote.TextWrapping = 'Wrap'; [void]$preferencesPanel.Children.Add($languageNote)
  $minMatch = Add-ProfileField $preferencesPanel 'Encaje mínimo (%)' ([string]$(if ($saved.settings.minimumMatch) { $saved.settings.minimumMatch } else { 60 }))
  $interval = Add-ProfileField $preferencesPanel 'Revisar ofertas cada (minutos, desde 1)' ([string]$(if ($saved.settings.intervalMinutes) { $saved.settings.intervalMinutes } else { 30 }))
  $searchNote = New-Object System.Windows.Controls.TextBlock; $searchNote.Text = 'Esto define cada ciclo de búsqueda. No aumenta por sí solo el número de formularios completables; las candidaturas tienen un límite separado.'; $searchNote.FontSize = 11; $searchNote.Foreground = $script:MutedBrush; $searchNote.TextWrapping = 'Wrap'; $searchNote.Margin = '0,5,0,0'; [void]$preferencesPanel.Children.Add($searchNote)
  $dailyLimit = Add-ProfileField $preferencesPanel 'Límite diario de candidaturas' ([string]$(if ($saved.settings.dailyLimit) { $saved.settings.dailyLimit } elseif ($p.dailyLimit) { $p.dailyLimit } else { 5 }))
  $answersCard = New-Object System.Windows.Controls.Border; $answersCard.Background = $cardBrush; $answersCard.BorderBrush = $cardBorderBrush; $answersCard.BorderThickness = '1'; $answersCard.CornerRadius = '8'; $answersCard.Padding = '16'; $answersCard.Margin = '0,12,0,0'; [void]$form.Children.Add($answersCard)
  $answersPanel = New-Object System.Windows.Controls.StackPanel; $answersCard.Child = $answersPanel
  $answersHeading = New-Object System.Windows.Controls.TextBlock; $answersHeading.Text = 'Respuestas para formularios'; $answersHeading.FontSize = 16; $answersHeading.FontWeight = 'SemiBold'; $answersHeading.Foreground = $script:InkBrush; [void]$answersPanel.Children.Add($answersHeading)
  $answersHelp = New-Object System.Windows.Controls.TextBlock; $answersHelp.Text = 'Agregá respuestas verdaderas para preguntas abiertas. Una por línea: parte de la pregunta = respuesta. Consentimientos, privacidad, declaraciones legales y verificaciones se revisan manualmente.'; $answersHelp.FontSize = 12; $answersHelp.Foreground = $script:MutedBrush; $answersHelp.TextWrapping = 'Wrap'; $answersHelp.Margin = '0,4,0,0'; [void]$answersPanel.Children.Add($answersHelp)
  $answerLines = @(); if ($p.applicationAnswers -and $p.applicationAnswers.fields) { foreach ($property in $p.applicationAnswers.fields.PSObject.Properties) { $answerLines += "$($property.Name) = $($property.Value)" } }
  $answers = Add-ProfileField $answersPanel 'Pregunta reconocible = respuesta' ($answerLines -join "`n") 120
  $cvCard = New-Object System.Windows.Controls.Border; $cvCard.Background = $cardBrush; $cvCard.BorderBrush = $cardBorderBrush; $cvCard.BorderThickness = '1'; $cvCard.CornerRadius = '8'; $cvCard.Padding = '16'; $cvCard.Margin = '0,12,0,0'; [void]$form.Children.Add($cvCard)
  $cvPanel = New-Object System.Windows.Controls.StackPanel; $cvCard.Child = $cvPanel
  $cvHeading = New-Object System.Windows.Controls.TextBlock; $cvHeading.Text = 'CV y personalización'; $cvHeading.FontSize = 16; $cvHeading.FontWeight = 'SemiBold'; $cvHeading.Foreground = $script:InkBrush; [void]$cvPanel.Children.Add($cvHeading)
  $cvNote = New-Object System.Windows.Controls.TextBlock; $cvNote.Text = 'El texto se procesa localmente con TF-IDF. El CV adaptado reordena contenido existente; no inventa experiencia ni logros.'; $cvNote.FontSize = 12; $cvNote.Foreground = $script:MutedBrush; $cvNote.TextWrapping = 'Wrap'; $cvNote.Margin = '0,4,0,0'; [void]$cvPanel.Children.Add($cvNote)
  $cvRow = New-Object System.Windows.Controls.StackPanel; $cvRow.Orientation = 'Horizontal'; $cvRow.Margin = '0,10,0,3'; [void]$cvPanel.Children.Add($cvRow)
  $chooseCv = New-Object System.Windows.Controls.Button; $chooseCv.Content = 'Cargar y analizar CV'; [void]$cvRow.Children.Add($chooseCv)
  $fileLabel = New-Object System.Windows.Controls.TextBlock; $fileLabel.Text = if ($p.resume) { 'CV guardado localmente' } else { 'Todavía no cargaste un CV' }; $fileLabel.VerticalAlignment = 'Center'; $fileLabel.Margin = '10,0,0,0'; $fileLabel.Foreground = $script:MutedBrush; [void]$cvRow.Children.Add($fileLabel)
  $resume = Add-ProfileField $cvPanel 'Texto del CV' ([string]$p.resume) 220
  $summary = Add-ProfileField $cvPanel 'Resumen profesional (opcional)' ([string]$p.summary) 90
  $skills = Add-ProfileField $cvPanel 'Habilidades (opcional)' ([string]$p.skills) 64
  $chooseCv.Add_Click({
    $picker = New-Object Microsoft.Win32.OpenFileDialog; $picker.Title = 'Elegí tu CV'; $picker.Filter = 'CV PDF o texto (*.pdf;*.txt)|*.pdf;*.txt'; $picker.CheckFileExists = $true
    if ($picker.ShowDialog($dialog) -ne $true) { return }
    $info = Get-Item -LiteralPath $picker.FileName
    if ($info.Length -gt 8MB) { [System.Windows.MessageBox]::Show('El CV supera el límite de 8 MB.', 'Postula') | Out-Null; return }
    try {
      $bytes = [System.IO.File]::ReadAllBytes($picker.FileName)
      $analysis = Invoke-PostulaApi '/api/analyze-cv' @{ fileName = $info.Name; contentBase64 = [Convert]::ToBase64String($bytes) }
      $resume.Text = [string]$analysis.text; $fileLabel.Text = "Analizado: $($info.Name) · $($analysis.skills.Count) habilidades detectadas"
      if (-not $linkedin.Text.Trim() -and $analysis.linkedin) { $linkedin.Text = [string]$analysis.linkedin }
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
      if (-not [int]::TryParse($dailyLimit.Text, [ref]$dailyLimitValue) -or $dailyLimitValue -lt 1 -or $dailyLimitValue -gt 10000) { throw 'El límite diario debe ser un número entre 1 y 10.000.' }
      $minimumMatchValue = 0
      if (-not [int]::TryParse($minMatch.Text, [ref]$minimumMatchValue) -or $minimumMatchValue -lt 30 -or $minimumMatchValue -gt 95) { throw 'El encaje mínimo debe estar entre 30 y 95.' }
      $intervalValue = 0
      if (-not [int]::TryParse($interval.Text, [ref]$intervalValue) -or $intervalValue -lt 1 -or $intervalValue -gt 1440) { throw 'La frecuencia debe ser un número de 1 a 1440 minutos.' }
      $profileData = @{
        name = $name.Text.Trim(); email = $email.Text.Trim(); phone = $phone.Text.Trim(); location = $location.Text.Trim(); currentCompany = $currentCompany.Text.Trim(); linkedin = $linkedin.Text.Trim();
        roles = $roles.Text.Trim(); mode = [string]$mode.SelectedItem; resume = $resume.Text.Trim(); summary = $summary.Text.Trim();
        experience = [string]$p.experience; skills = $skills.Text.Trim(); link = $portfolio.Text.Trim(); portfolio = $portfolio.Text.Trim();
        salaryExpectation = $salary.Text.Trim(); workAuthorization = $authorization.Text.Trim();
        regionPreference = @('regional-first', 'regional-only', 'balanced')[[int]$region.SelectedIndex];
        languagePreference = @('spanish-first', 'spanish-only', 'any')[[int]$language.SelectedIndex];
        applicationAnswers = $p.applicationAnswers
      }
      $answerFields = @{}
      foreach ($line in ($answers.Text -split "`r?`n")) {
        if ($line -match '^\s*(.{3,160}?)\s*=\s*(.{1,1200})\s*$') { $answerFields[$matches[1].Trim()] = $matches[2].Trim() }
      }
      $profileData.applicationAnswers = @{ radio = @($p.applicationAnswers.radio); checkboxes = @($p.applicationAnswers.checkboxes); fields = $answerFields }
      $response = Invoke-PostulaApi '/api/configure' @{ profile = $profileData; minimumMatch = $minimumMatchValue; dailyLimit = $dailyLimitValue; intervalMinutes = $intervalValue }
      $dialog.Close()
      [System.Windows.MessageBox]::Show("Perfil guardado. El agente inició una búsqueda con $($response.minimumMatch)% de encaje y volverá a revisar cada $($response.intervalMinutes) minutos. El máximo de postulaciones es un ajuste separado.", 'Postula') | Out-Null
    } catch { $button.IsEnabled = $true; $button.Content = 'Guardar y buscar ahora'; [System.Windows.MessageBox]::Show("Revisá los campos obligatorios y volvé a intentar:`n$($_.Exception.Message)", 'Postula', 'OK', 'Warning') | Out-Null }
  }.GetNewClosure())
  [void]$dialog.ShowDialog()
}

function Get-StatusLabel([string]$status) {
  switch ($status) {
    'discovered' { 'Detectada · todavía sin procesar' }
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
    $rule = New-Object System.Windows.Controls.Border; $rule.Height = 1; $rule.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#2B2E31'); $rule.Margin = '0,0,0,0'
    $cell = New-Object System.Windows.Controls.StackPanel; [void]$cell.Children.Add($row); [void]$cell.Children.Add($rule)
    [void]$script:RecentHost.Children.Add($cell)
  }
}

function Render-Applications($items) {
  $script:ApplicationsHost.Children.Clear()
  $submitted = @($items | Where-Object { [string]$_.status -in @('submitted', 'submitted_unconfirmed') } | Sort-Object -Property at -Descending | Select-Object -First 100)
  $script:ApplicationsCount.Text = if ($submitted.Count -eq 1) { '1 candidatura enviada' } else { "$($submitted.Count) candidaturas enviadas" }
  $script:ApplicationsEmpty.Visibility = if ($submitted.Count -eq 0) { [System.Windows.Visibility]::Visible } else { [System.Windows.Visibility]::Collapsed }
  foreach ($item in $submitted) {
    $row = New-Object System.Windows.Controls.Grid; $row.Margin = '0,10,0,10'
    [void]$row.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $actionColumn = New-Object System.Windows.Controls.ColumnDefinition; $actionColumn.Width = [System.Windows.GridLength]::Auto; [void]$row.ColumnDefinitions.Add($actionColumn)
    $details = New-Object System.Windows.Controls.StackPanel
    $role = New-Object System.Windows.Controls.TextBlock; $role.Text = [string]$item.role; $role.FontSize = 14; $role.FontWeight = 'SemiBold'; $role.Foreground = $script:InkBrush; $role.TextWrapping = 'Wrap'
    $company = New-Object System.Windows.Controls.TextBlock; $company.Text = "$($item.company) · $($item.source)"; $company.FontSize = 11; $company.Foreground = $script:MutedBrush; $company.Margin = '0,3,0,0'
    $dateLabel = if ($item.at) { try { ([DateTime]::Parse([string]$item.at)).ToLocalTime().ToString('dd/MM/yyyy HH:mm') } catch { [string]$item.at } } else { 'Fecha no disponible' }
    $status = if ($item.status -eq 'submitted') { 'Confirmada por el portal' } else { 'Enviada · confirmación no detectada' }
    $meta = New-Object System.Windows.Controls.TextBlock; $meta.Text = "$status · $dateLabel"; $meta.FontSize = 10; $meta.Foreground = $script:MutedBrush; $meta.Margin = '0,4,0,0'
    [void]$details.Children.Add($role); [void]$details.Children.Add($company); [void]$details.Children.Add($meta); [void]$row.Children.Add($details)
    $open = New-Object System.Windows.Controls.Button; $open.Content = 'Abrir aviso ↗'; $open.FontSize = 11; $open.Padding = '9,4'; $open.Margin = '12,0,0,0'; $open.VerticalAlignment = 'Center'
    $open.Add_Click({ $url = [string]$item.url; $uri = $null; if ([Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -in @('https','http')) { Start-Process $uri.AbsoluteUri } }.GetNewClosure())
    [System.Windows.Controls.Grid]::SetColumn($open, 1); [void]$row.Children.Add($open)
    [void]$script:ApplicationsHost.Children.Add($row)
    $rule = New-Object System.Windows.Controls.Border; $rule.Height = 1; $rule.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#2B2E31'); [void]$script:ApplicationsHost.Children.Add($rule)
  }
}

function Render-Matches($items, $history) {
  $script:LastMatches = @($items)
  $script:LastOffers = @($history)
  $script:MatchesHost.Children.Clear()
  $unique = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($script:LastOffers) + @($script:LastMatches)) {
    $key = if ($entry.id) { [string]$entry.id } elseif ($entry.jobId) { [string]$entry.jobId } else { "$($entry.company)|$($entry.role)" }
    if ($key -and $seen.Add($key)) { $unique.Add($entry) }
  }
  $query = [string]$script:SearchBox.Text
  $filter = if ($script:OffersFilter.SelectedItem) { [string]$script:OffersFilter.SelectedItem.Content } else { 'Todas' }
  $minimum = if ($script:LastData.minimumMatch) { [int]$script:LastData.minimumMatch } else { 60 }
  $filtered = @($unique | Where-Object {
    $status = [string]$_.status
    $searchText = "$($_.role) $($_.company) $($_.location) $($_.region) $($_.source)"
    $matchesSearch = -not $query -or $searchText -like "*$query*"
    $matchesFilter = switch ($filter) {
      'Compatibles' { ([int]$_.match -ge $minimum) -and $status -ne 'excluded' }
      'Requieren atención' { $status -in @('needs_attention', 'error', 'no_application_form') }
      'Enviadas' { $status -in @('submitted', 'submitted_unconfirmed') }
      default { $true }
    }
    $matchesSearch -and $matchesFilter
  })
  $visible = @($filtered | Select-Object -First $script:DisplayedOfferCount)
  $totalFound = if ($script:LastData.jobsFound) { [int]$script:LastData.jobsFound } else { 0 }
  $inScope = if ($script:LastData.offersInScope) { [int]$script:LastData.offersInScope } else { $filtered.Count }
  $script:MatchesCountLabel.Text = "$($visible.Count) de $($filtered.Count) mostrados · $inScope en alcance · $totalFound leídos"
  $script:ShowMoreOffers.Visibility = if ($filtered.Count -gt $visible.Count) { [System.Windows.Visibility]::Visible } else { [System.Windows.Visibility]::Collapsed }
  $script:ShowMoreOffers.Content = "Mostrar más · quedan $([Math]::Max(0, $filtered.Count - $visible.Count))"
  if ($visible.Count -eq 0) {
    $empty = New-Object System.Windows.Controls.TextBlock
    $empty.Text = if ($query -or $filter -ne 'Todas') { 'No hay avisos que coincidan con este filtro.' } elseif ($script:LastOffers.Count) { 'No hay resultados guardados todavía.' } else { 'No hay ofertas recientes para mostrar. Revisá tu CV y preferencias de búsqueda.' }; $empty.FontSize = 12; $empty.Foreground = $script:MutedBrush; $empty.TextWrapping = 'Wrap'
    [void]$script:MatchesHost.Children.Add($empty); return
  }
  foreach ($entry in $visible) {
    $item = $entry
    $grid = New-Object System.Windows.Controls.Grid; $grid.Margin = '0,6,0,6'
    [void]$grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $actionColumn = New-Object System.Windows.Controls.ColumnDefinition; $actionColumn.Width = [System.Windows.GridLength]::Auto; [void]$grid.ColumnDefinitions.Add($actionColumn)
    $discardColumn = New-Object System.Windows.Controls.ColumnDefinition; $discardColumn.Width = [System.Windows.GridLength]::Auto; [void]$grid.ColumnDefinitions.Add($discardColumn)
    $details = New-Object System.Windows.Controls.StackPanel
    $role = New-Object System.Windows.Controls.TextBlock; $role.Text = [string]$item.role; $role.FontSize = 13; $role.FontWeight = 'SemiBold'; $role.Foreground = $script:InkBrush; $role.TextWrapping = 'Wrap'
    $company = New-Object System.Windows.Controls.TextBlock; $company.Text = "$($item.company) · $($item.source)"; $company.FontSize = 11; $company.Foreground = $script:MutedBrush; $company.Margin = '0,2,0,0'
    $score = if ($null -ne $item.match -and [string]$item.match) { "$($item.match)% de encaje" } else { 'Sin puntaje' }
    $metaParts = @(); if ($item.region) { $metaParts += [string]$item.region }; if ($item.location) { $metaParts += [string]$item.location }; if ($item.language) { $metaParts += [string]$item.language }; $metaParts += $score
    $meta = New-Object System.Windows.Controls.TextBlock; $meta.Text = $metaParts -join ' · '; $meta.FontSize = 10; $meta.Foreground = $script:MutedBrush; $meta.Margin = '0,2,0,0'; $meta.TextWrapping = 'Wrap'
    $statusLabel = if ($item.status) { Get-StatusLabel ([string]$item.status) } else { 'Nueva · pendiente de revisión' }
    $statusText = New-Object System.Windows.Controls.TextBlock; $statusText.Text = $statusLabel; $statusText.FontSize = 10; $statusText.Foreground = if ([string]$item.status -in @('submitted','submitted_unconfirmed')) { $script:GreenBrush } else { $script:MutedBrush }; $statusText.Margin = '0,3,0,0'
    [void]$details.Children.Add($role); [void]$details.Children.Add($company); [void]$details.Children.Add($meta); [void]$details.Children.Add($statusText)
    if ($item.reason -and [string]$item.status -in @('needs_attention','error','no_application_form')) { $reason = New-Object System.Windows.Controls.TextBlock; $reason.Text = [string]$item.reason; $reason.FontSize = 10; $reason.Foreground = $script:MutedBrush; $reason.TextWrapping = 'Wrap'; $reason.MaxHeight = 44; $reason.Margin = '0,3,0,0'; [void]$details.Children.Add($reason) }
    [void]$grid.Children.Add($details)
    $open = New-Object System.Windows.Controls.Button; $open.Content = 'Abrir oferta ↗'; $open.FontSize = 11; $open.Padding = '9,4'; $open.Margin = '10,0,0,0'; $open.VerticalAlignment = 'Center'
    $open.Add_Click({
      $targetUrl = [string]$item.url; $parsed = $null
      if ([Uri]::TryCreate($targetUrl, [UriKind]::Absolute, [ref]$parsed) -and $parsed.Scheme -in @('https', 'http')) { Start-Process $parsed.AbsoluteUri }
    }.GetNewClosure())
    [System.Windows.Controls.Grid]::SetColumn($open, 1); [void]$grid.Children.Add($open)
    if ([string]$item.status -notin @('excluded', 'submitted', 'submitted_unconfirmed')) {
      $discard = New-Object System.Windows.Controls.Button; $discard.Content = 'Descartar'; $discard.FontSize = 10; $discard.Padding = '8,4'; $discard.Margin = '6,0,0,0'; $discard.VerticalAlignment = 'Center'; $discard.ToolTip = 'Quitar esta oferta de la búsqueda y de la cola de revisión'
      $discard.Add_Click({
        try {
          Invoke-PostulaApi '/api/exclude' @{ jobId = [string]$item.jobId } | Out-Null
          $discard.Content = 'Descartada'; $discard.IsEnabled = $false
        } catch { [System.Windows.MessageBox]::Show($_.Exception.Message, 'Postula') | Out-Null }
      }.GetNewClosure())
      [System.Windows.Controls.Grid]::SetColumn($discard, 2); [void]$grid.Children.Add($discard)
    }
    $divider = New-Object System.Windows.Controls.Border; $divider.Height = 1; $divider.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#2B2E31')
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
    $match = New-Object System.Windows.Controls.TextBlock; $match.Text = "Encaje estimado: $($pendingItem.match)% · el formulario está listo y todavía no se envió. Tenés 5 minutos para confirmarlo."; $match.FontSize = 12; $match.Foreground = $script:MutedBrush; $match.Margin = '0,10,0,12'; $match.TextWrapping = 'Wrap'
    $actions = New-Object System.Windows.Controls.StackPanel; $actions.Orientation = 'Horizontal'
    $send = New-Object System.Windows.Controls.Button; $send.Content = 'Confirmar y enviar'; $send.Style = $window.FindResource('PrimaryButton')
    $send.Add_Click({
      $confirmationText = "Esto enviará tu CV y los datos de tu perfil a $($pendingItem.company) para el puesto $($pendingItem.role).`n`n¿Confirmás el envío?"
      $choice = [System.Windows.MessageBox]::Show($confirmationText, 'Confirmar postulación', 'YesNo', 'Warning')
      if ($choice -ne 'Yes') { return }
      $send.IsEnabled = $false
      try { Invoke-PostulaApi '/api/approve' @{ jobId = [string]$pendingItem.jobId } | Out-Null; $send.Content = 'Envío autorizado' }
      catch { $send.IsEnabled = $true; $send.Content = 'Confirmar y enviar'; [System.Windows.MessageBox]::Show($_.Exception.Message, 'Postula') | Out-Null }
    }.GetNewClosure())
    [void]$actions.Children.Add($send)
    $note = New-Object System.Windows.Controls.TextBlock; $note.Text = "Al confirmar, Postula enviará el formulario a $($pendingItem.company). Si el portal pide CAPTCHA o una respuesta que no está en tu perfil, la candidatura queda fuera de esta lista."; $note.FontSize = 12; $note.Foreground = $script:MutedBrush; $note.TextWrapping = 'Wrap'; $note.Margin = '0,9,0,0'
    [void]$card.Children.Add($role); [void]$card.Children.Add($company); [void]$card.Children.Add($match); [void]$card.Children.Add($actions); [void]$card.Children.Add($note)
    [void]$script:ApprovalHost.Children.Add($card)
  }
}

function Update-Window($data) {
  $script:LastData = $data
  $script:ConnectionDot.Fill = $script:GreenBrush
  $script:SidebarDot.Fill = $script:GreenBrush
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
  $searchRequested = $phase -match '^Buscando ofertas|Búsqueda solicitada|Perfil guardado · buscando ahora'
  $script:SearchNowButton.IsEnabled = -not $searchRequested
  $script:SearchNowButton.Content = if ($searchRequested) { 'Buscando…' } else { 'Buscar ofertas' }
  $script:MetricProcessed.Text = [string]$processed
  $script:MetricMatched.Text = [string]$matched
  $script:MetricReady.Text = [string](@($data.pendingApprovals).Count)
  $script:MetricSubmitted.Text = [string]$submitted
  $script:PhaseLabel.Text = $phase
  $script:PhaseLabelTop.Text = $phase
  $script:SidebarPhase.Text = $phase
  $isWorking = $status.phase -match 'buscando|búsqueda solicitada|revisando|completando|enviando|esperando tu confirmaci[oó]n|verificaci[oó]n'
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
  $script:SidebarDot.Fill = if ($isWorking) { $script:BlueBrush } else { $script:GreenBrush }
  Set-Pipeline ([string]$job.stage) ([string]$status.phase)
  Render-Matches $status.matches $data.offers
  Render-Recent $data.recent
  Render-Approvals $data.pendingApprovals
  Render-Applications $data.applications
  $topErrors = @($data.offers | Where-Object { $_.status -in @('needs_attention','error','no_application_form') } | Select-Object -First 1)
  if ($matched -eq 0 -and $status.bestMatch) { $script:DiagnosticsLabel.Text = "El mínimo configurado es $($data.minimumMatch)%. La oferta más cercana es $($status.bestMatch.role) · $($status.bestMatch.company), con $($status.bestMatch.match)% ($($data.minimumMatch - $status.bestMatch.match) puntos por debajo). Podés bajar el mínimo en Preferencias de búsqueda." }
  elseif ($topErrors.Count) { $script:DiagnosticsLabel.Text = "Último bloqueo: $($topErrors[0].company) · $(Get-StatusLabel ([string]$topErrors[0].status)). $([string]$topErrors[0].reason)" }
  else { $script:DiagnosticsLabel.Text = 'Fuentes públicas activas. Cada búsqueda lee ofertas y aplica el puntaje local del perfil.' }
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
$script:SearchNowButton.Add_Click({
  $script:SearchNowButton.IsEnabled = $false
  $script:SearchNowButton.Content = 'Buscando…'
  try {
    Invoke-PostulaApi '/api/search-now' @{} | Out-Null
  } catch {
    $script:SearchNowButton.IsEnabled = $true
    $script:SearchNowButton.Content = 'Buscar ofertas'
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Postula') | Out-Null
  }
}.GetNewClosure())
$script:ConfigureButton.Add_Click({ Show-ProfileDialog })
$window.FindName('NavProfile').Add_Click({ Show-ProfileDialog })
$window.FindName('SidebarProfileNav').Add_Click({ Show-ProfileDialog })
$goToSection = {
  param($TargetName)
  $script:OverviewView.Visibility = [System.Windows.Visibility]::Visible
  $script:ApplicationsView.Visibility = [System.Windows.Visibility]::Collapsed
  $script:MainScroll.ScrollToTop()
  $target = $window.FindName($TargetName)
  if ($target) {
    $window.UpdateLayout()
    $point = $target.TransformToAncestor($script:MainScroll).Transform([System.Windows.Point]::new(0, 0))
    $script:MainScroll.ScrollToVerticalOffset([Math]::Max(0, $point.Y - 18))
  }
}.GetNewClosure()
$showOverview = {
  $script:ApplicationsView.Visibility = [System.Windows.Visibility]::Collapsed
  $script:OverviewView.Visibility = [System.Windows.Visibility]::Visible
  $script:MainScroll.ScrollToTop()
}.GetNewClosure()
$showApplications = {
  $script:OverviewView.Visibility = [System.Windows.Visibility]::Collapsed
  $script:ApplicationsView.Visibility = [System.Windows.Visibility]::Visible
  $script:MainScroll.ScrollToTop()
  $script:ApplicationsView.UpdateLayout()
}.GetNewClosure()
$window.FindName('NavActivity').Add_Click({ & $goToSection 'CurrentCard' }.GetNewClosure())
$window.FindName('SidebarActivityNav').Add_Click({ & $goToSection 'CurrentCard' }.GetNewClosure())
$showAllOffers = { $script:OffersFilter.SelectedIndex = 0; & $goToSection 'MatchesCard' }.GetNewClosure()
$window.FindName('ApplicationsSearchButton').Add_Click({ & $showAllOffers }.GetNewClosure())
$window.FindName('NavOffers').Add_Click($showAllOffers)
$window.FindName('SidebarOffersNav').Add_Click($showAllOffers)
$script:NavApplicationsButton.Add_Click($showApplications)
$window.FindName('SidebarApplicationsNav').Add_Click($showApplications)
$script:ShowMoreOffers.Add_Click({ $script:DisplayedOfferCount += 20; Render-Matches $script:LastMatches $script:LastOffers })
$script:OffersFilter.Add_SelectionChanged({ $script:DisplayedOfferCount = 20; if ($script:LastData) { Render-Matches $script:LastMatches $script:LastOffers } })
$script:SearchBox.Add_TextChanged({
  $script:DisplayedOfferCount = 20
  $script:SearchPlaceholder.Visibility = if ($script:SearchBox.Text) { [System.Windows.Visibility]::Collapsed } else { [System.Windows.Visibility]::Visible }
  if ($script:LastData) { Render-Matches $script:LastMatches $script:LastOffers }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({
  try {
    $data = Invoke-RestMethod -Uri "$($script:ApiBase)/api/status" -TimeoutSec 2
    Update-Window $data
    $script:AgentToggle.IsEnabled = $true
  } catch {
    $script:ConnectionDot.Fill = $script:GrayBrush
    $script:SidebarDot.Fill = $script:GrayBrush
    $script:ConnectionLabel.Text = 'Agente desconectado'
    $script:SearchNowButton.IsEnabled = $false
    $script:SearchNowButton.Content = 'Buscar ofertas'
    $script:UpdatedLabel.Text = 'La ventana sigue abierta'
    $script:PhaseLabel.Text = 'Agente detenido'
    $script:SidebarPhase.Text = 'Agente detenido'
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
