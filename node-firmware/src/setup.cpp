#include "setup.hpp"
#include <array>
#include <charconv>

namespace mesh {
std::optional<SetupCommand> parse_setup(std::string_view line) {
    if (line == "GET") return SetupCommand{Command::get, {}};
    if (line == "REBOOT") return SetupCommand{Command::reboot, {}};
    if (line == "TEST") return SetupCommand{Command::test, {}};
    if (line == "HEALTH") return SetupCommand{Command::health, {}};
    if (line.substr(0, 4) != "SET ") return {};
    line.remove_prefix(4);
    std::array<uint32_t, 6> values{};
    for (size_t i = 0; i < values.size(); ++i) {
        const auto end = line.find(' ');
        const auto token = line.substr(0, end);
        const auto parsed = std::from_chars(token.data(), token.data() + token.size(), values[i]);
        if (token.empty() || parsed.ec != std::errc{} || parsed.ptr != token.data() + token.size()) return {};
        if (i + 1 == values.size()) { if (end != std::string_view::npos) return {}; }
        else { if (end == std::string_view::npos) return {}; line.remove_prefix(end + 1); }
    }
    node_settings_t s{values[0], values[1], values[2], values[3], values[4], values[5]};
    if (!s.node_id || !valid_settings(&s)) return {};
    return SetupCommand{Command::set, s};
}
}
