import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";

import {
  json,
  redirect,
} from "@remix-run/node";
import {
  Form,
  useLoaderData,
  useActionData,
  useFetcher,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Checkbox,
  Card,
  FormLayout,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useMemo, useRef, useState } from "react";

import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const categorySearch =
    url.searchParams.get("categorySearch")?.trim() ?? "";

  const response = await admin.graphql(`
    #graphql
    query Locations {
      locations(first: 20) {
        nodes {
          id
          name
          isActive
        }
      }
      
      publications(first: 20) {
        nodes {
          id
          name
          autoPublish
        }
      }

      collections(first: 50, query: "collection_type:manual") {
        nodes {
          id
          title
          handle
        }
      }
    }
  `);

  const body = await response.json();

  let categories: Array<{
    id: string;
    name: string;
    fullName: string;
  }> = [];

  if (categorySearch.length >= 2) {
    const categoryResponse = await admin.graphql(
      `#graphql
        query SearchCategories($search: String!) {
          taxonomy {
            categories(first: 15, search: $search) {
              nodes {
                id
                name
                fullName
              }
            }
          }
        }
      `,
      {
        variables: {
          search: categorySearch,
        },
      },
    );

    const categoryBody = await categoryResponse.json();

    categories =
      categoryBody.data?.taxonomy?.categories?.nodes ?? [];
  }

  return json({
    locations: body.data?.locations?.nodes ?? [],
    publications: body.data?.publications?.nodes ?? [],
    collections: body.data?.collections?.nodes ?? [],
    categories,
  });
}



const CREATE_PRODUCT = `#graphql
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        options {
          id
          name
          position
          optionValues {
            id
            name
          }
        }
        variants(first: 10) {
          nodes {
            id
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_VARIANTS = `#graphql
  mutation CreateVariants(
    $productId: ID!,
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(
      productId: $productId,
      variants: $variants,
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants {
        id
        title
        sku
        price
        compareAtPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;
const STAGED_UPLOADS_CREATE = `#graphql
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_MEDIA = `#graphql
  mutation CreateProductMedia(
    $productId: ID!,
    $media: [CreateMediaInput!]!
  ) {
    productCreateMedia(
      productId: $productId,
      media: $media
    ) {
      media {
        id
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;
const UPDATE_VARIANT_MEDIA = `#graphql
  mutation UpdateVariantMedia(
    $productId: ID!,
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(
      productId: $productId,
      variants: $variants
    ) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
const PUBLISH_PRODUCT = `#graphql
  mutation PublishProduct(
    $id: ID!,
    $input: [PublicationInput!]!
  ) {
    publishablePublish(
      id: $id,
      input: $input
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_PRODUCT_TO_COLLECTION = `#graphql
  mutation AddProductToCollection(
    $id: ID!,
    $productIds: [ID!]!
  ) {
    collectionAddProducts(
      id: $id,
      productIds: $productIds
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

interface VariantDraft {
  id: string;
  color: string;
  size: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  stock: string;
}

interface SubmittedVariant {
  color: string;
  size: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  stock: string;
}

interface UserError {
  field?: string[] | null;
  message: string;
}

interface ProductImageDraft {
  id: string;
  file: File;
  previewUrl: string;
  color: string;
}

function parseValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function skuPart(value: string, length = 4): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, length);
}

function productSkuPrefix(title: string): string {
  const words = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length >= 2) {
    return `${skuPart(words[0], 3)}${skuPart(words[1], 3)}`;
  }

  if (words.length === 1) {
    return skuPart(words[0], 6);
  }

  return "PRODUC";
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const imageFiles = formData
  .getAll("images")
  .filter(
    (value): value is File =>
      value instanceof File && value.size > 0,
  );

  let imageColors: string[] = [];

  try {
    const parsed = JSON.parse(
      String(formData.get("imageColors") ?? "[]"),
    );

    imageColors = Array.isArray(parsed)
      ? parsed.map((value) => String(value ?? "").trim())
      : [];
  } catch {
    imageColors = [];
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "");
  const vendor = String(formData.get("vendor") ?? "").trim();
  const productType = String(formData.get("productType") ?? "").trim();
  const status = String(formData.get("status") ?? "DRAFT");

  const materials = String(
    formData.get("materials") ?? "",
  ).trim();

  const careInstructions = String(
    formData.get("careInstructions") ?? "",
  ).trim();

  const shippingReturns = String(
    formData.get("shippingReturns") ?? "",
  ).trim();

  const seoTitle = String(
    formData.get("seoTitle") ?? "",
  ).trim();

  const seoDescription = String(
    formData.get("seoDescription") ?? "",
  ).trim();

  const tags = String(formData.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const locationId = String(
  formData.get("locationId") ?? "",
  ).trim();

  const publicationsRaw = String(
    formData.get("publications") ?? "[]",
  );

  let publicationIds: string[] = [];

  try {
    publicationIds = JSON.parse(publicationsRaw);
  } catch {
    publicationIds = [];
  }

  const categoryId = String(
    formData.get("categoryId") ?? "",
  ).trim();

  const collectionId = String(
    formData.get("collectionId") ?? "",
  ).trim();

  let variants: SubmittedVariant[] = [];

  try {
    variants = JSON.parse(
      String(formData.get("variants") ?? "[]"),
    ) as SubmittedVariant[];
  } catch {
    return json(
      {
        ok: false,
        error: "Variant data could not be read.",
      },
      { status: 400 },
    );
  }

  if (!title) {
    return json(
      {
        ok: false,
        error: "Product title is required.",
      },
      { status: 400 },
    );
  }

  if (variants.length === 0) {
    return json(
      {
        ok: false,
        error: "Generate at least one variant.",
      },
      { status: 400 },
    );
  }

  if (!locationId) {
  return json(
    {
      ok: false,
      error: "Select an inventory location.",
    },
    { status: 400 },
  );
  }

  if (imageFiles.length > 10) {
    return json(
      {
        ok: false,
        error: "You can upload a maximum of 10 images.",
      },
      { status: 400 },
    );
  }

  const allowedImageTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);

  for (const file of imageFiles) {
    if (!allowedImageTypes.has(file.type)) {
      return json(
        {
          ok: false,
          error: `Unsupported image type: ${file.name}`,
        },
        { status: 400 },
      );
    }
  }

  const colors = [...new Set(
    variants
      .map((variant) => variant.color)
      .filter(Boolean),
  )];

  const sizes = [...new Set(
    variants
      .map((variant) => variant.size)
      .filter(Boolean),
  )];

  const productOptions = [];

  if (colors.length > 0) {
    productOptions.push({
      name: "Color",
      values: colors.map((name) => ({ name })),
    });
  }

  if (sizes.length > 0) {
    productOptions.push({
      name: "Talla",
      values: sizes.map((name) => ({ name })),
    });
  }

  const productResponse = await admin.graphql(
    CREATE_PRODUCT,
    {
      variables: {
        product: {
          title,
          descriptionHtml: description,

          vendor: vendor || undefined,
          productType: productType || undefined,

          ...(categoryId
            ? {
                category: categoryId,
              }
            : {}),

          status,
          tags,
          productOptions,

          seo: {
            ...(seoTitle
              ? {
                  title: seoTitle,
                }
              : {}),

            ...(seoDescription
              ? {
                  description: seoDescription,
                }
              : {}),
          },

          metafields: [
            ...(materials
              ? [
                  {
                    namespace: "custom",
                    key: "materials",
                    type: "multi_line_text_field",
                    value: materials,
                  },
                ]
              : []),

            ...(careInstructions
              ? [
                  {
                    namespace: "custom",
                    key: "care_instructions",
                    type: "multi_line_text_field",
                    value: careInstructions,
                  },
                ]
              : []),

            ...(shippingReturns
              ? [
                  {
                    namespace: "custom",
                    key: "shipping_returns",
                    type: "multi_line_text_field",
                    value: shippingReturns,
                  },
                ]
              : []),
          ],
        },
      },
    },
  );

  const productBody = await productResponse.json();

  const productCreate =
    productBody.data?.productCreate;

  const productErrors: UserError[] =
    productCreate?.userErrors ?? [];

  if (productErrors.length > 0 || !productCreate?.product) {
    return json(
      {
        ok: false,
        error:
          productErrors[0]?.message ??
          "The product could not be created.",
      },
      { status: 400 },
    );
  }

  const product = productCreate.product;

  const optionByName = new Map<string, string>();

  for (const option of product.options) {
    optionByName.set(option.name, option.id);
  }

  const variantInputs = variants.map((variant) => {
    const optionValues = [];

    if (variant.color && optionByName.has("Color")) {
      optionValues.push({
        name: variant.color,
        optionId: optionByName.get("Color"),
      });
    }

    if (variant.size && optionByName.has("Talla")) {
      optionValues.push({
        name: variant.size,
        optionId: optionByName.get("Talla"),
      });
    }

    return {
      price: variant.price || "0",

      ...(variant.compareAtPrice
        ? {
            compareAtPrice: variant.compareAtPrice,
          }
        : {}),

      inventoryItem: {
        tracked: true,
        ...(variant.sku
          ? {
              sku: variant.sku,
            }
          : {}),
      },

      inventoryQuantities: [
        {
          locationId,
          availableQuantity: Math.max(
            0,
            Number.parseInt(variant.stock || "0", 10) || 0,
          ),
        },
      ],

      optionValues,
    };
  });

  const variantsResponse = await admin.graphql(
    CREATE_VARIANTS,
    {
      variables: {
        productId: product.id,
        variants: variantInputs,
      },
    },
  );

  const variantsBody = await variantsResponse.json();

  const variantsCreate =
    variantsBody.data?.productVariantsBulkCreate;

  const variantErrors: UserError[] =
    variantsCreate?.userErrors ?? [];

  const createdVariants =
    variantsCreate?.productVariants ?? [];

  if (variantErrors.length > 0) {
    return json(
      {
        ok: false,
        error:
          variantErrors[0]?.message ??
          "The variants could not be created.",
      },
      { status: 400 },
    );
  }

  if (imageFiles.length > 0) {
  const stagedResponse = await admin.graphql(
    STAGED_UPLOADS_CREATE,
    {
      variables: {
        input: imageFiles.map((file) => ({
          filename: file.name,
          mimeType: file.type,
          resource: "PRODUCT_IMAGE",
          httpMethod: "POST",
        })),
      },
    },
  );

  const stagedBody = await stagedResponse.json();

  const stagedResult =
    stagedBody.data?.stagedUploadsCreate;

  const stagedErrors: UserError[] =
    stagedResult?.userErrors ?? [];

  if (stagedErrors.length > 0) {
    return json(
      {
        ok: false,
        error:
          stagedErrors[0]?.message ??
          "Could not prepare image upload.",
      },
      { status: 400 },
    );
  }

  const targets = stagedResult?.stagedTargets ?? [];

  if (targets.length !== imageFiles.length) {
    return json(
      {
        ok: false,
        error: "Shopify did not create all image upload targets.",
      },
      { status: 400 },
    );
  }

  const mediaInputs = [];

  const imageAssignments = imageFiles.map(
    (file, index) => {
      const color =
        imageColors[index]?.trim() ?? "";

      return {
        file,
        color,
        alt: color
          ? `${title} - ${color}`
          : title,
      };
    },
  );

  for (let index = 0; index < imageFiles.length; index++) {
    const file = imageFiles[index];
    const target = targets[index];

    const uploadForm = new FormData();

    for (const parameter of target.parameters) {
      uploadForm.append(
        parameter.name,
        parameter.value,
      );
    }

    uploadForm.append(
      "file",
      file,
      file.name,
    );

    const uploadResponse = await fetch(
      target.url,
      {
        method: "POST",
        body: uploadForm,
      },
    );

    if (!uploadResponse.ok) {
      return json(
        {
          ok: false,
          error: `Could not upload image: ${file.name}`,
        },
        { status: 400 },
      );
    }

    mediaInputs.push({
      mediaContentType: "IMAGE",
      originalSource: target.resourceUrl,
      alt: imageAssignments[index].alt,
    });
  }

  const mediaResponse = await admin.graphql(
    CREATE_MEDIA,
    {
      variables: {
        productId: product.id,
        media: mediaInputs,
      },
    },
  );

  const mediaBody = await mediaResponse.json();

  const mediaErrors: UserError[] =
    mediaBody.data?.productCreateMedia
      ?.mediaUserErrors ?? [];

  if (mediaErrors.length > 0) {
    return json(
      {
        ok: false,
        error:
          mediaErrors[0]?.message ??
          "Images could not be attached to the product.",
      },
      { status: 400 },
    );
  }
  const createdMedia =
    mediaBody.data?.productCreateMedia?.media ?? [];

  const mediaByColor = new Map<string, string>();

  for (const media of createdMedia) {
    if (!media?.id || !media?.alt) {
      continue;
    }

    const assignment = imageAssignments.find(
      (image) =>
        image.color &&
        image.alt === media.alt,
    );

    if (!assignment) {
      continue;
    }

    const colorKey =
      assignment.color.toLowerCase();

    // Si hay varias imágenes para el mismo color,
    // la primera será la imagen principal de variante.
    if (!mediaByColor.has(colorKey)) {
      mediaByColor.set(colorKey, media.id);
    }
  }

  const variantMediaInputs = variants.flatMap(
    (variant) => {
      if (!variant.color) {
        return [];
      }

      const mediaId = mediaByColor.get(
        variant.color.trim().toLowerCase(),
      );

      if (!mediaId) {
        return [];
      }

      const createdVariant =
        createdVariants.find(
          (item: any) =>
            item.sku === variant.sku,
        );

      if (!createdVariant?.id) {
        return [];
      }

      return [
        {
          id: createdVariant.id,
          mediaId,
        },
      ];
    },
  );

  if (variantMediaInputs.length > 0) {
    const variantMediaResponse =
      await admin.graphql(
        UPDATE_VARIANT_MEDIA,
        {
          variables: {
            productId: product.id,
            variants: variantMediaInputs,
          },
        },
      );

    const variantMediaBody =
      await variantMediaResponse.json();

    const variantMediaErrors: UserError[] =
      variantMediaBody.data
        ?.productVariantsBulkUpdate
        ?.userErrors ?? [];

    if (variantMediaErrors.length > 0) {
      return json(
        {
          ok: false,
          error:
            variantMediaErrors[0]?.message ??
            "Could not associate images with variants.",
        },
        { status: 400 },
      );
    }
  }
}

  if (publicationIds.length > 0) {
  const publishResponse = await admin.graphql(
    PUBLISH_PRODUCT,
    {
      variables: {
        id: product.id,
        input: publicationIds.map((publicationId) => ({
          publicationId,
        })),
      },
    },
  );

  const publishBody = await publishResponse.json();

  const publishErrors: UserError[] =
    publishBody.data?.publishablePublish?.userErrors ?? [];

  if (publishErrors.length > 0) {
    return json(
      {
        ok: false,
        error:
          publishErrors[0]?.message ??
          "Could not publish the product.",
      },
      { status: 400 },
    );
  }
}

  if (collectionId) {
    const collectionResponse = await admin.graphql(
      ADD_PRODUCT_TO_COLLECTION,
      {
        variables: {
          id: collectionId,
          productIds: [product.id],
        },
      },
    );

    const collectionBody =
      await collectionResponse.json();

    const collectionErrors: UserError[] =
      collectionBody.data?.collectionAddProducts
        ?.userErrors ?? [];

    if (collectionErrors.length > 0) {
      return json(
        {
          ok: false,
          error:
            collectionErrors[0]?.message ??
            "Could not add product to collection.",
        },
        { status: 400 },
      );
    }
  }


  return redirect("/app");
}

export default function CreateProduct() {
  const { locations, publications, collections  } =
    useLoaderData<typeof loader>();
  const [locationId, setLocationId] = useState( 
    locations.find((location: any) => location.isActive)?.id ?? "",
    );
  const [collectionId, setCollectionId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("BonsaStore");
  const [productType, setProductType] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState("DRAFT");

  const [colorsText, setColorsText] = useState("");
  const [sizesText, setSizesText] = useState("");
  const [variants, setVariants] = useState<VariantDraft[]>([]);

  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkCompareAtPrice, setBulkCompareAtPrice] = useState("");
  const [bulkStock, setBulkStock] = useState("");

  const colors = useMemo(() => parseValues(colorsText), [colorsText]);
  const sizes = useMemo(() => parseValues(sizesText), [sizesText]);

  const [selectedPublications, setSelectedPublications] = useState<string[]>([]);

  const categoryFetcher = useFetcher<typeof loader>();

  const [categorySearch, setCategorySearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");

  const [aiDetails, setAiDetails] = useState("");
  const [features, setFeatures] = useState("");
  const [materials, setMaterials] = useState("");
  const [careInstructions, setCareInstructions] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [shippingReturns, setShippingReturns] = useState(
    `Envíos nacionales de 2 a 5 días hábiles.

  Aceptamos cambios y devoluciones dentro de los 30 días siguientes a la entrega, siempre que el producto se encuentre sin uso y en su empaque original.`
  );

  const mergeTags = (currentTags: string, aiTags: string) => {
  const allTags = [
    ...currentTags.split(","),
    ...aiTags.split(","),
  ]
    .map((tag) => tag.trim())
    .filter(Boolean);

  return [...new Set(allTags)].join(", ");
};

  const [generatingContent, setGeneratingContent] = useState(false);
  const [aiError, setAiError] = useState("");

  const generateProductContent = async () => {
  if (!title.trim()) {
    setAiError("Enter a product title first.");
    return;
  }

  setGeneratingContent(true);
  setAiError("");

  try {
    const colorList = colors
      .map((color) => color.trim())
      .filter(Boolean);

    const response = await fetch(
      "/app/api/generate-product-content",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          vendor,
          productType,
          categoryName,
          colors: colorList,
          aiDetails,
        }),
      },
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(
        result.error || "Could not generate content.",
      );
    }

    setDescription(result.content.description);
    setFeatures(result.content.features);
    setMaterials(result.content.materials);
    setCareInstructions(result.content.careInstructions);
    setSeoTitle(result.content.seoTitle);
    setSeoDescription(result.content.seoDescription);

    if (result.content.tags) {
      setTags((current) =>
        mergeTags(current, result.content.tags),
      );
    }
  } catch (error) {
    setAiError(
      error instanceof Error
        ? error.message
        : "Could not generate content.",
    );
  } finally {
    setGeneratingContent(false);
  }
};

  const searchCategories = () => {
  const value = categorySearch.trim();

  if (value.length < 2) return;

    categoryFetcher.load(
      `/app/products/new?categorySearch=${encodeURIComponent(value)}`,
    );
  };

  const generateVariants = () => {
    const generated: VariantDraft[] = [];

    const effectiveColors = colors.length > 0 ? colors : [""];
    const effectiveSizes = sizes.length > 0 ? sizes : [""];

    for (const color of effectiveColors) {
      for (const size of effectiveSizes) {
        const parts = [
          productSkuPrefix(title),
          color ? skuPart(color) : "",
          size ? skuPart(size, 6) : "",
        ].filter(Boolean);

        generated.push({
          id: `${color}-${size}-${generated.length}`,
          color,
          size,
          sku: parts.join("-"),
          price: "",
          compareAtPrice: "",
          stock: "0",
        });
      }
    }

    setVariants(generated);
  };

  const updateVariant = (
    index: number,
    field: keyof VariantDraft,
    value: string,
  ) => {
    setVariants((current) =>
      current.map((variant, variantIndex) =>
        variantIndex === index
          ? {
              ...variant,
              [field]: value,
            }
          : variant,
      ),
    );
  };

  const removeVariant = (index: number) => {
    setVariants((current) =>
    current.filter((_, variantIndex) => variantIndex !== index),
    );
  };

  const applyPriceToAll = () => {
  setVariants((current) =>
    current.map((variant) => ({
      ...variant,
      price: bulkPrice,
    })),
  );
};

const applyCompareAtToAll = () => {
  setVariants((current) =>
    current.map((variant) => ({
      ...variant,
      compareAtPrice: bulkCompareAtPrice,
    })),
  );
};

const applyStockToAll = () => {
  setVariants((current) =>
    current.map((variant) => ({
      ...variant,
      stock: bulkStock,
    })),
  );
};

const actionData = useActionData<typeof action>();
const navigation = useNavigation();

const busy = navigation.state !== "idle";
const submit = useSubmit();
const formRef = useRef<HTMLFormElement>(null);

const handleCreateProduct = () => {
  if (!formRef.current) return;

  const formData = new FormData(formRef.current);

  for (const image of images) {
    formData.append(
      "images",
      image.file,
      image.file.name,
    );
  }

  submit(formData, {
    method: "post",
    encType: "multipart/form-data",
  });
};

const [images, setImages] = useState<ProductImageDraft[]>([]);

  const handleImagesChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);

  const nextImages = files.map((file) => ({
    id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
    file,
    previewUrl: URL.createObjectURL(file),
    color: "",
  }));

  setImages((current) => [...current, ...nextImages]);

  event.target.value = "";
};

  const updateImageColor = (
    id: string,
    color: string,
  ) => {
    setImages((current) =>
      current.map((image) =>
        image.id === id
          ? {
              ...image,
              color,
            }
          : image,
      ),
    );
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const found = current.find((image) => image.id === id);

      if (found) {
        URL.revokeObjectURL(found.previewUrl);
      }

      return current.filter((image) => image.id !== id);
    });
  };

  return (
  <Form method="post" ref={formRef}>
    <Page
      title="Create product"
      backAction={{
        content: "Products",
        url: "/app",
      }}
      primaryAction={{
        content: busy ? "Creating..." : "Create product",
        disabled:
          !title.trim() ||
          variants.length === 0 ||
          busy,
        loading: busy,
        onAction: handleCreateProduct,
      }}
    >
      <input type="hidden" name="title" value={title} />
      <input type="hidden" name="description" value={description} />
      <input type="hidden" name="vendor" value={vendor} />
      <input type="hidden" name="productType" value={productType} />
      <input type="hidden" name="tags" value={tags} />
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="locationId" value={locationId} />
      <input
        type="hidden"
        name="collectionId"
        value={collectionId}
      />
      <input type="hidden" name="features" value={features} />
      <input type="hidden" name="materials" value={materials} />
      <input type="hidden" name="careInstructions" value={careInstructions} />
      <input type="hidden" name="shippingReturns" value={shippingReturns} />
      <input type="hidden" name="seoTitle" value={seoTitle} />
      <input type="hidden" name="seoDescription" value={seoDescription} />

      <input
        type="hidden"
        name="variants"
        value={JSON.stringify(variants)}
      />
      <input
        type="hidden"
        name="publications"
        value={JSON.stringify(selectedPublications)}
      />
      <input
        type="hidden"
        name="categoryId"
        value={categoryId}
      />
      <input
        type="hidden"
        name="imageColors"
        value={JSON.stringify(
          images.map((image) => image.color),
        )}
      />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData && !actionData.ok ? (
              <Banner
                tone="critical"
                title="Product could not be created"
              >
                <p>{actionData.error}</p>
              </Banner>
            ) : null}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  1. Product information
                </Text>

                <FormLayout>
                  <TextField
                    label="Product title"
                    value={title}
                    onChange={setTitle}
                    autoComplete="off"
                  />

                  <FormLayout.Group>
                    <TextField
                      label="Vendor"
                      value={vendor}
                      onChange={setVendor}
                      autoComplete="off"
                    />

                    <TextField
                      label="Product type"
                      value={productType}
                      onChange={setProductType}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                  <Select
                    label="Collection"
                    options={[
                      { label: "No collection", value: "" },
                      ...collections.map((collection: any) => ({
                        label: collection.title,
                        value: collection.id,
                      })),
                    ]}
                    value={collectionId}
                    onChange={setCollectionId}
                  />
                  <BlockStack gap="200">
                    <TextField
                      label="Shopify category"
                      value={categorySearch}
                      onChange={setCategorySearch}
                      autoComplete="off"
                      placeholder="Ej: shoes, sneakers, calzado..."
                    />

                    <Button
                      onClick={searchCategories}
                      loading={categoryFetcher.state !== "idle"}
                    >
                      Search category
                    </Button>

                    {categoryFetcher.data?.categories?.length ? (
                      <BlockStack gap="100">
                        {categoryFetcher.data.categories.map((category) => (
                          <Button
                            key={category.id}
                            variant={
                              categoryId === category.id
                                ? "primary"
                                : "secondary"
                            }
                            onClick={() => {
                              setCategoryId(category.id);
                              setCategoryName(category.fullName);
                            }}
                          >
                            {category.fullName}
                          </Button>
                        ))}
                      </BlockStack>
                    ) : null}

                    {categoryName ? (
                      <Text as="p">
                        Selected: {categoryName}
                      </Text>
                    ) : null}
                  </BlockStack>
                  <TextField
                    label="Tags"
                    value={tags}
                    onChange={setTags}
                    helpText="Separate tags with commas."
                    autoComplete="off"
                  />
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="h2" variant="headingMd">
                            ✨ AI product assistant
                          </Text>

                          <Text as="p" tone="subdued">
                            Generate product content using the information already entered.
                          </Text>
                        </BlockStack>

                        <Button
                          variant="primary"
                          onClick={generateProductContent}
                          loading={generatingContent}
                          disabled={!title.trim()}
                        >
                          Generate with AI
                        </Button>
                      </InlineStack>
                      {aiError ? (
                        <Text as="p" tone="critical">
                          {aiError}
                        </Text>
                      ) : null}
                      <TextField
                        label="Additional product details"
                        value={aiDetails}
                        onChange={setAiDetails}
                        multiline={4}
                        autoComplete="off"
                        placeholder="Ej: cuero sintético, suela de caucho, estilo casual, inspiración retro..."
                        helpText="Only enter details you know are correct. AI will use these as product facts."
                      />
                    </BlockStack>
                  </Card>
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">
                        Product content
                      </Text>

                      <TextField
                        label="Description"
                        value={description}
                        onChange={setDescription}
                        multiline={6}
                        autoComplete="off"
                      />

                      <FormLayout.Group>
                        <TextField
                          label="Key features"
                          value={features}
                          onChange={setFeatures}
                          multiline={5}
                          autoComplete="off"
                        />

                        <TextField
                          label="Materials"
                          value={materials}
                          onChange={setMaterials}
                          multiline={5}
                          autoComplete="off"
                        />
                      </FormLayout.Group>

                      <FormLayout.Group>
                        <TextField
                          label="Care instructions"
                          value={careInstructions}
                          onChange={setCareInstructions}
                          multiline={4}
                          autoComplete="off"
                        />

                        <TextField
                          label="Shipping & returns"
                          value={shippingReturns}
                          onChange={setShippingReturns}
                          multiline={4}
                          autoComplete="off"
                          helpText="Manual field. It will not be generated by AI."
                        />
                      </FormLayout.Group>

                      <FormLayout.Group>
                        <TextField
                          label="SEO title"
                          value={seoTitle}
                          onChange={setSeoTitle}
                          autoComplete="off"
                        />

                        <TextField
                          label="SEO description"
                          value={seoDescription}
                          onChange={setSeoDescription}
                          multiline={3}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                    </BlockStack>
                  </Card>
                  <Select
                    label="Status"
                    options={[
                      { label: "Draft", value: "DRAFT" },
                      { label: "Active", value: "ACTIVE" },
                    ]}
                    value={status}
                    onChange={setStatus}
                  />
                  <Select
                    label="Inventory location"
                    options={[
                      { label: "Select a location", value: "" },
                      ...locations
                        .filter((location: any) => location.isActive)
                        .map((location: any) => ({
                          label: location.name,
                          value: location.id,
                        })),
                    ]}
                    value={locationId}
                    onChange={setLocationId}
                  />
                </FormLayout>
              </BlockStack>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Sales channels
                </Text>

                {publications.map((publication: any) => (
                  <Checkbox
                    key={publication.id}
                    label={publication.name}
                    checked={selectedPublications.includes(publication.id)}
                    onChange={(checked) => {
                      setSelectedPublications((current) =>
                        checked
                          ? [...current, publication.id]
                          : current.filter((id) => id !== publication.id),
                      );
                    }}
                  />
                ))}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  2. Product images
                </Text>

                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={handleImagesChange}
                />

                {images.length > 0 ? (
                  <InlineStack gap="300" wrap>
                    {images.map((image) => (
                      <div
                        key={image.id}
                        style={{
                          width: "190px",
                          border: "1px solid #ddd",
                          borderRadius: "8px",
                          padding: "8px",
                        }}
                      >
                        <img
                          src={image.previewUrl}
                          alt=""
                          style={{
                            width: "100%",
                            height: "120px",
                            objectFit: "cover",
                            borderRadius: "6px",
                          }}
                        />

                        <BlockStack gap="200">
                          <Select
                            label="Variant color"
                            options={[
                              { label: "No color assigned", value: "" },
                              ...colors.map((color) => ({
                                label: color,
                                value: color,
                              })),
                            ]}
                            value={image.color}
                            onChange={(value) =>
                              updateImageColor(image.id, value)
                            }
                            disabled={colors.length === 0}
                          />

                          <Button
                            tone="critical"
                            variant="plain"
                            onClick={() => removeImage(image.id)}
                          >
                            Remove
                          </Button>
                        </BlockStack>
                      </div>
                    ))}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued">
                    No images selected.
                  </Text>
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  3. Options and variants
                </Text>

                <FormLayout>
                  <TextField
                    label="Colors"
                    value={colorsText}
                    onChange={setColorsText}
                    placeholder="White, Black, Gray"
                    helpText="Separate each color with commas."
                    autoComplete="off"
                  />

                  <TextField
                    label="Sizes"
                    value={sizesText}
                    onChange={setSizesText}
                    placeholder="39, 40, 41, 42, 43"
                    helpText="Separate each size with commas."
                    autoComplete="off"
                  />
                </FormLayout>

                <InlineStack gap="300" blockAlign="center">
                  <Button
                    variant="primary"
                    onClick={generateVariants}
                    disabled={colors.length === 0 && sizes.length === 0}
                  >
                    Generate variants
                  </Button>

                  <Text as="span" tone="subdued">
                    {colors.length > 0 && sizes.length > 0
                      ? `${colors.length} colors × ${sizes.length} sizes = ${
                          colors.length * sizes.length
                        } variants`
                      : "Enter colors and/or sizes."}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {variants.length > 0 ? (
              <Card padding="0">
                <BlockStack gap="300">
                  <div style={{ padding: "16px 16px 0" }}>
                    <Text as="h2" variant="headingMd">
                      Variants ({variants.length})
                    </Text>
                  </div>
                  <div style={{ padding: "0 16px 16px" }}>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Bulk values
                    </Text>

                    <InlineStack gap="300" wrap>
                      <div style={{ minWidth: "180px" }}>
                        <TextField
                          label="Price for all"
                          type="number"
                          value={bulkPrice}
                          onChange={setBulkPrice}
                          autoComplete="off"
                        />
                      </div>

                      <Button
                        onClick={applyPriceToAll}
                        disabled={!bulkPrice}
                      >
                        Apply price
                      </Button>

                      <div style={{ minWidth: "180px" }}>
                        <TextField
                          label="Compare-at for all"
                          type="number"
                          value={bulkCompareAtPrice}
                          onChange={setBulkCompareAtPrice}
                          autoComplete="off"
                        />
                      </div>

                      <Button
                        onClick={applyCompareAtToAll}
                        disabled={!bulkCompareAtPrice}
                      >
                        Apply compare-at
                      </Button>

                      <div style={{ minWidth: "150px" }}>
                        <TextField
                          label="Stock for all"
                          type="number"
                          value={bulkStock}
                          onChange={setBulkStock}
                          autoComplete="off"
                        />
                      </div>

                      <Button
                        onClick={applyStockToAll}
                        disabled={bulkStock === ""}
                      >
                        Apply stock
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </div>
                  <IndexTable
                    resourceName={{
                      singular: "variant",
                      plural: "variants",
                    }}
                    itemCount={variants.length}
                    selectable={false}
                    headings={[
                      { title: "Color" },
                      { title: "Size" },
                      { title: "SKU" },
                      { title: "Price" },
                      { title: "Compare at" },
                      { title: "Stock" },
                      { title: "" },
                    ]}
                  >
                    {variants.map((variant, index) => (
                      <IndexTable.Row
                        id={variant.id}
                        key={variant.id}
                        position={index}
                      >
                        <IndexTable.Cell>
                          {variant.color || "—"}
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          {variant.size || "—"}
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <TextField
                            label={`SKU ${index + 1}`}
                            labelHidden
                            value={variant.sku}
                            onChange={(value) =>
                              updateVariant(index, "sku", value)
                            }
                            autoComplete="off"
                          />
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <TextField
                            label={`Price ${index + 1}`}
                            labelHidden
                            type="number"
                            value={variant.price}
                            onChange={(value) =>
                              updateVariant(index, "price", value)
                            }
                            autoComplete="off"
                          />
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <TextField
                            label={`Compare at ${index + 1}`}
                            labelHidden
                            type="number"
                            value={variant.compareAtPrice}
                            onChange={(value) =>
                              updateVariant(
                                index,
                                "compareAtPrice",
                                value,
                              )
                            }
                            autoComplete="off"
                          />
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <TextField
                            label={`Stock ${index + 1}`}
                            labelHidden
                            type="number"
                            value={variant.stock}
                            onChange={(value) =>
                              updateVariant(index, "stock", value)
                            }
                            autoComplete="off"
                          />
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <Button
                            tone="critical"
                            variant="plain"
                            onClick={() => removeVariant(index)}
                          >
                            Remove
                          </Button>
                        </IndexTable.Cell>

                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
        </Page>
  </Form>
);
}