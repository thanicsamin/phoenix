self: { config, lib, pkgs, ... }:
let
  cfg = config.services.phoenix;
  setupFile = pkgs.writeText "phoenix-agent.json" (builtins.toJSON cfg.setup);
in {
  options.services.phoenix = {
    enable = lib.mkEnableOption "Phoenix personal agent";
    package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.default; };
    setup = lib.mkOption {
      type = lib.types.attrs;
      default = builtins.fromJSON (builtins.readFile ../agent.json);
      description = "Shareable setup. Use environmentFile for secrets; Nix store contents are public.";
    };
    environmentFile = lib.mkOption { type = lib.types.str; description = "Absolute path to a private file of environment secrets."; };
    memoryLimit = lib.mkOption { type = lib.types.str; default = "2G"; description = "Hard memory cap for the service and all of its browser processes."; };
    extraPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = []; description = "Additional programs required by your Pi extensions."; };
  };
  config = lib.mkIf cfg.enable {
    systemd.services.phoenix = {
      description = "Phoenix personal agent";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = cfg.extraPackages;
      environment = { PHOENIX_CONFIG = setupFile; PHOENIX_DATA = "/var/lib/phoenix"; HOME = "/var/lib/phoenix"; UV_PYTHON_DOWNLOADS = "never"; UV_PYTHON_PREFERENCE = "only-system"; NODE_OPTIONS = "--max-old-space-size=256"; };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/phoenix";
        EnvironmentFile = cfg.environmentFile;
        DynamicUser = true;
        StateDirectory = "phoenix";
        StateDirectoryMode = "0700";
        UMask = "0077";
        MemoryMax = cfg.memoryLimit;
        MemorySwapMax = 0;
        Restart = "on-failure";
        RestartSec = 5;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      };
    };
  };
}
