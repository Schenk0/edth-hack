#include "mesh.hpp"
#include <cassert>
#include <cstdio>
int main() {
    for (uint8_t id = 1; id <= 3; ++id) {
        mesh::Mesh node(id);
        assert(node.solve(0).status == mesh::Status::missing);
        assert(node.receive({mesh::Kind::range, 1, 1, 2, 1, 1, 4000, 0, 0}, 0));
        assert(node.solve(1).status == mesh::Status::missing);
    }
    puts("PASS: default firmware withholds positions until all three measured ranges exist");
}
