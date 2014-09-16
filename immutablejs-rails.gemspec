# coding: utf-8
lib = File.expand_path('../lib', __FILE__)
$LOAD_PATH.unshift(lib) unless $LOAD_PATH.include?(lib)
require 'immutablejs/rails/version'

Gem::Specification.new do |spec|
  spec.name          = "immutablejs-rails"
  spec.version       = Immutablejs::Rails::VERSION
  spec.authors       = ["Tom Chen"]
  spec.email         = ["developer@tomchentw.com"]
  spec.summary       = %q{Immutable Data Collections for JavaScripts.}
  spec.description   = %q{Immutable Data Collections for JavaScripts.}
  spec.homepage      = "https://github.com/tomchentw/immutablejs-rails"
  spec.license       = "MIT"

  spec.files         = `git ls-files -z`.split("\x0")
  spec.executables   = spec.files.grep(%r{^bin/}) { |f| File.basename(f) }
  spec.test_files    = spec.files.grep(%r{^(test|spec|features)/})
  spec.require_paths = ["lib"]

  spec.add_development_dependency "bundler", "~> 1.7"
  spec.add_development_dependency "rake", "~> 10.0"
end
