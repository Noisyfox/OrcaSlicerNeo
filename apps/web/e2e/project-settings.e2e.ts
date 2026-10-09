import { test, expect } from './browser-fixture';


test('real Project process catalogue includes object and region defaults and edits Fuzzy skin', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('config-mode-project')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Search settings', exact: true }).click();
  const search = page.getByTestId('scoped-config-search');

  // Use the actual Worker metadata rather than a mocked scope list, covering
  // representative Quality, Strength, Speed, Support and Other defaults.
  for (const [key, label] of [
    ['layer_height', 'Layer height'], ['wall_loops', 'Wall loops'],
    ['inner_wall_speed', 'Inner wall'], ['enable_support', 'Enable support'],
    ['seam_position', 'Seam position'],
  ]) {
    await search.fill(label);
    await expect(page.getByTestId(`config-field-${key}`)).toBeVisible();
  }
  for (const [key, label] of [
    ['staggered_inner_seams', 'Staggered inner seams'],
    ['gcode_add_line_number', 'Add line number'], ['gcode_comments', 'Verbose G-code'],
    ['gcode_label_objects', 'Label objects'],
  ]) {
    await search.fill(label);
    const field = page.getByTestId(`config-field-${key}`);
    await expect(field).toBeVisible();
    const checkbox = field.getByRole('checkbox');
    const inherited = await checkbox.getAttribute('aria-checked');
    await checkbox.click();
    await expect(checkbox).toHaveAttribute('aria-checked', inherited === 'true' ? 'false' : 'true');
    await expect(page.getByTestId(`config-option-label-${key}`))
      .toHaveAttribute('data-local-override-highlight', 'true');
    await page.getByTestId(`config-reset-${key}`).click();
    await expect(checkbox).toHaveAttribute('aria-checked', inherited!);
    await expect(page.getByTestId(`config-option-label-${key}`))
      .toHaveAttribute('data-local-override-highlight', 'false');
  }
  for (const key of ['extruder_ams_count', 'process_change_extrusion_role_gcode']) {
    await search.fill(key);
    await expect(page.getByTestId(`config-field-${key}`)).toHaveCount(0);
  }
  await search.fill('Fuzzy skin');
  for (const key of ['fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_distance'])
    await expect(page.getByTestId(`config-field-${key}`)).toBeVisible();

  const thickness = page.getByTestId('config-input-fuzzy_skin_thickness');
  const inheritedThickness = await thickness.inputValue();
  await thickness.fill('0.42');
  await thickness.press('Enter');
  await expect(page.getByTestId('config-option-label-fuzzy_skin_thickness'))
    .toHaveAttribute('data-local-override-highlight', 'true');
  await expect(thickness).toHaveValue('0.42');

  const fuzzy = page.getByTestId('config-input-fuzzy_skin');
  await fuzzy.click();
  await page.getByRole('option', { name: 'All walls', exact: true }).click();
  await expect(fuzzy).toContainText('All walls');
  await expect(page.getByTestId('config-option-label-fuzzy_skin'))
    .toHaveAttribute('data-local-override-highlight', 'true');

  await expect(page.getByRole('option', { name: 'All walls', exact: true })).toHaveCount(0);
  // Search unmounts the field. Its native effective enum value and readable
  // label must survive creation of a fresh Select without registered items.
  await search.fill('Layer height');
  await expect(fuzzy).toHaveCount(0);
  await search.fill('Fuzzy skin');
  await expect(fuzzy).toContainText('All walls');
  await fuzzy.click();
  await expect(page.getByRole('option', { name: 'All walls', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(fuzzy).toContainText('All walls');

  await page.getByTestId('config-reset-fuzzy_skin_thickness').click();
  await expect(thickness).toHaveValue(inheritedThickness);
  await expect(page.getByTestId('config-option-label-fuzzy_skin_thickness'))
    .toHaveAttribute('data-local-override-highlight', 'false');
  await expect(fuzzy).toContainText('All walls');
  await expect(page.getByTestId('config-error-fuzzy_skin')).toHaveCount(0);
});
