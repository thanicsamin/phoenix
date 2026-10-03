{ pkgs }:
let
  fonts = pkgs.runCommand "phoenix-fonts" {} ''
    mkdir -p $out/etc/fonts
    ln -s ${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }} $out/etc/fonts/fonts.conf
  '';
in pkgs.buildEnv {
  name = "phoenix-runtime";
  paths = with pkgs; [ nodejs_24 nix chromium xorg.xorgserver python3 uv curl ffmpeg poppler-utils cloudflared bashInteractive coreutils git jq ripgrep cacert fonts ];
  pathsToLink = [ "/bin" "/etc" ];
}
