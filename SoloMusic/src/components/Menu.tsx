
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";

function Menu() {
  return (
    <Menubar>
      {/* Home */}
      <MenubarMenu>
        <MenubarTrigger>Home</MenubarTrigger>
      </MenubarMenu>

      {/* Connect */}
      <MenubarMenu>
        <MenubarTrigger>Connect</MenubarTrigger>
        <MenubarContent>
          <MenubarGroup>
            <MenubarItem>
              Random
              <MenubarShortcut>⌘T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>Groups</MenubarItem>
          </MenubarGroup>

          <MenubarSeparator />

          <MenubarGroup>
            <MenubarItem>Host</MenubarItem>
            <MenubarItem>Join</MenubarItem>
          </MenubarGroup>
        </MenubarContent>
      </MenubarMenu>

      {/* Social */}
      <MenubarMenu>
        <MenubarTrigger>Social</MenubarTrigger>
        <MenubarContent>
          <MenubarGroup>
            <MenubarItem>
              Posts
              <MenubarShortcut>⌘T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>Games</MenubarItem>
          </MenubarGroup>
        </MenubarContent>
      </MenubarMenu>

      {/* Guide */}
      <MenubarMenu>
        <MenubarTrigger>Guide</MenubarTrigger>
      </MenubarMenu>
    </Menubar>
  );
}

export default Menu;
