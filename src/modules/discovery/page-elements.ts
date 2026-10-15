import { z } from "zod";

/**
 * What discovery records about a page (`DiscoveredPage.elements`). Only structure is kept —
 * names, types, labels and targets. Field values (including anything a page pre-fills) are
 * never captured.
 */
const text = z.string().max(200);

export const fieldSchema = z.object({
  tag: z.enum(["input", "select", "textarea"]),
  type: z.string().max(40),
  name: text.nullable(),
  label: text.nullable(),
  placeholder: text.nullable(),
  required: z.boolean(),
});

export const pageElementsSchema = z.object({
  headings: z.array(text).max(20),
  links: z.array(z.object({ href: z.string().max(2048), text, inNavigation: z.boolean() })).max(300),
  navigation: z
    .array(z.object({ label: text, links: z.array(z.object({ href: z.string().max(2048), text })).max(100) }))
    .max(10),
  forms: z
    .array(
      z.object({
        name: text.nullable(),
        action: z.string().max(2048).nullable(),
        method: z.enum(["GET", "POST", "DIALOG"]),
        fields: z.array(fieldSchema).max(100),
        submitLabels: z.array(text).max(10),
      }),
    )
    .max(50),
  buttons: z.array(z.object({ text, type: z.string().max(40), inForm: z.boolean() })).max(200),
  /** Inputs outside any <form> (e.g. SPA search boxes). */
  inputs: z.array(fieldSchema).max(200),
});

export type PageElements = z.infer<typeof pageElementsSchema>;
export type FormElement = PageElements["forms"][number];

export const EMPTY_PAGE_ELEMENTS: PageElements = { headings: [], links: [], navigation: [], forms: [], buttons: [], inputs: [] };

export function countElements(elements: PageElements) {
  return {
    links: elements.links.length,
    forms: elements.forms.length,
    buttons: elements.buttons.length,
    inputs: elements.inputs.length + elements.forms.reduce((sum, form) => sum + form.fields.length, 0),
    navigation: elements.navigation.length,
  };
}
