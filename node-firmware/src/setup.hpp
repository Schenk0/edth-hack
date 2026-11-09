#pragma once
#include "settings.h"
#include <optional>
#include <string_view>

namespace mesh {
enum class Command { get, set, reboot, test, health };
struct SetupCommand { Command command; node_settings_t settings; };
std::optional<SetupCommand> parse_setup(std::string_view line);
}
