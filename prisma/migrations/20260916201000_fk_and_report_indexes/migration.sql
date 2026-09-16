-- Remaining FK and report indexes. SQLite does not create these for you.
CREATE INDEX "Modifier_groupId_idx" ON "Modifier"("groupId");
CREATE INDEX "RecipeComponent_menuItemId_idx" ON "RecipeComponent"("menuItemId");
CREATE INDEX "RecipeComponent_inventoryItemId_idx" ON "RecipeComponent"("inventoryItemId");
CREATE INDEX "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");
CREATE INDEX "OrderItemModifier_orderItemId_idx" ON "OrderItemModifier"("orderItemId");
CREATE INDEX "OrderItemModifier_modifierId_idx" ON "OrderItemModifier"("modifierId");
CREATE INDEX "Order_status_closedAt_idx" ON "Order"("status", "closedAt");
CREATE INDEX "TicketRequest_requesterId_idx" ON "TicketRequest"("requesterId");
