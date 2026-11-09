#include "setup.hpp"
#include <cassert>
#include <cstdio>
using namespace mesh;
int main() {
    const auto s = parse_setup("SET 2 60785 10000 16385 16385 4294967295");
    assert(s && s->command == Command::set && s->settings.node_id == 2 && s->settings.tx_power == UINT32_MAX);
    assert(parse_setup("GET")->command == Command::get);
    assert(parse_setup("REBOOT")->command == Command::reboot);
    assert(parse_setup("TEST")->command == Command::test);
    assert(parse_setup("HEALTH")->command == Command::health);
    assert(!parse_setup("HEALTH junk"));
    assert(!parse_setup("TEST junk"));
    for (auto line : {"SET 0 1 0 1 1 0", "SET 4 1 0 1 1 0", "SET 1 0 0 1 1 0", "SET 1 65536 0 1 1 0",
        "SET 1 1 1000001 1 1 0", "SET 1 1 0 65536 1 0", "SET 1 1 0 1 1 -1", "SET 1 1 0 1 1 4294967296",
        "SET 1 1 0 1 1", "SET 1 1 0 1 1 0 extra", "SET 1 1 0 1 1 0 ", "SET 1  1 0 1 1 0", "SET 1 1 0 1 1 0xFF", "GET junk"})
        assert(!parse_setup(line));
    puts("PASS: strict USB setup commands and settings limits");
}
