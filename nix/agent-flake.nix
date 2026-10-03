{
  description = "Personal Phoenix tools; edit this flake to add packages";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forSystems = nixpkgs.lib.genAttrs systems;
      tools = system: let pkgs = import nixpkgs { inherit system; }; in with pkgs; [ ripgrep git jq python3 uv curl ffmpeg poppler-utils ];
    in {
      packages = forSystems (system: let pkgs = import nixpkgs { inherit system; }; in {
        default = pkgs.buildEnv { name = "phoenix-tools"; paths = tools system; };
      });
      devShells = forSystems (system: let pkgs = import nixpkgs { inherit system; }; in {
        default = pkgs.mkShell { packages = tools system; };
      });
    };
}
