{
  description = "Codebase Timeline Visualizer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = "codevis";
          version = "1.0.0";
          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;
          nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config ];
          doCheck = false; # tests shell out to `git`, not sandboxed at build time
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.rust-analyzer
            pkgs.clippy
            pkgs.rustfmt
            pkgs.cargo-tarpaulin
            pkgs.cmake
            pkgs.pkg-config
            pkgs.nodejs_22
            pkgs.git
          ];

          shellHook = ''
            echo "codebase-timeline-visualizer dev shell (rust $(rustc --version | cut -d' ' -f2), node $(node --version))"
          '';
        };
      });
}
