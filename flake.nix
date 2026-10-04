{
  description = "Phoenix: a shareable personal Pi agent";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forSystems = nixpkgs.lib.genAttrs systems;
      mkPackages = system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtime = import ./nix/runtime.nix { inherit pkgs; };
          app = pkgs.buildNpmPackage {
            pname = "phoenix-agent";
            version = "0.1.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [ ./package.json ./package-lock.json ./tsconfig.json ./tsconfig.web.json ./PHOENIX.md ./src ./extensions ./web ./agent.json ./flake.lock ./nix/agent-flake.nix ];
            };
            nodejs = pkgs.nodejs_24;
            npmDepsHash = "sha256-2whyy8zEcd7WvWOBoqNHmeL9AeneTmsK/gItX2nrmF0=";
            npmFlags = [ "--ignore-scripts" "--omit=dev" ];
            buildPhase = ''
              runHook preBuild
              node src/build.ts
              runHook postBuild
            '';
            installPhase = ''
              mkdir -p $out/share/phoenix $out/bin
              cp -r src extensions web agent.json PHOENIX.md package.json package-lock.json tsconfig.json tsconfig.web.json flake.lock node_modules $out/share/phoenix/
              mkdir -p $out/share/phoenix/nix
              cp nix/agent-flake.nix $out/share/phoenix/nix/
              cat > $out/bin/phoenix <<EOF
              #!${pkgs.bash}/bin/bash
              export PATH="\$HOME/.nix-profile/bin:${runtime}/bin:\$PATH"
              export FONTCONFIG_FILE="${runtime}/etc/fonts/fonts.conf"
              export CHROMIUM_PATH="${pkgs.chromium}/bin/chromium"
              export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              export PHOENIX_CONFIG="\''${PHOENIX_CONFIG:-$out/share/phoenix/agent.json}"
              exec ${pkgs.nodejs_24}/bin/node $out/share/phoenix/src/bootstrap.ts
              EOF
              chmod +x $out/bin/phoenix
            '';
          };
        in { inherit runtime; default = app; bootstrap = pkgs.pkgsStatic.busybox; };
    in {
      packages = forSystems mkPackages;
      devShells = forSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.chromium pkgs.xorg.xorgserver pkgs.cloudflared pkgs.nix pkgs.git pkgs.ripgrep pkgs.curl pkgs.python3 pkgs.uv pkgs.ffmpeg pkgs.poppler-utils ];
            UV_PYTHON_DOWNLOADS = "never";
            CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          };
        });
      nixosModules.default = import ./nix/module.nix self;
    };
}
