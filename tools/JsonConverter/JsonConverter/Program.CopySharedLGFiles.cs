﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.IO;
using System.Text;

namespace JsonConverter
{
    partial class Program
    {
        // after all ConvertJsonFilesToLG
        public void CopySharedLGFiles(params string[] folders)
        {
            var responseFolder = GetFullPath(folders);
            Directory.CreateDirectory(responseFolder);
            var target = Path.Combine(responseFolder, "Shared.lg");

            try
            {
                File.Copy("Shared.lg", target, false);
            }
            catch (IOException ex)
            {
                Console.Write($"{target} already exists! {ex.Message}");
            }
            finally
            {
                foreach (var pair in convertedTextsFiles)
                {
                    pair.Value.Add(target);
                }
            }
        }
    }
}